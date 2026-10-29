/**
 * DeepSeek Harness - Task Dispatcher & Acceptance Verifier (dsh-task-dispatcher)
 *
 * Architecture:
 * 1. Task Offloading: Delegating localized/routine tasks to subagent workers.
 * 2. Automated Acceptance: Multi-dimensional verification (file check, command test, criteria check).
 * 3. Context & Token Optimization: Prevents context window bloating and eliminates high reasoning tokens.
 *
 * Compatibility notes (0.2.1-rc):
 * - Tools are registered through `ctx.tools.register()` with a RAW JSON Schema
 *   (`{ type:'object', properties, required:[...] }`). Per-property
 *   `required: true` is NOT part of the supported subset and makes
 *   registration throw — the tool schema here is already normalized.
 * - Subagents are started through `ctx.subagents.startActivation()`, following
 *   the first-party `dsh-tool-subagent` call shape, and joined with
 *   `ctx.subagents.waitForChildren(parent)` before acceptance checks run.
 */

import { exec as nodeExec } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(nodeExec);

export const name = 'dsh-task-dispatcher';
export const inject = ['tools', 'systemPrompt', 'subagents'];

const DEFAULT_CONFIG = {
  toolName: 'dispatch_task',
  defaultReasoningEffort: 'low',
  defaultProvider: '',
  defaultModel: '',
  maxRounds: 3,
  maxResultChars: 16384,
  autoVerifyFiles: true,
  subagentProvider: 'spawn',
  verificationTimeoutMs: 30000,
};

function formatDeliveryReport(data) {
  const isAccepted = data.status === 'accepted';
  const statusEmoji = isAccepted ? '✅' : '⚠️';
  const statusText = isAccepted ? '验收通过 (Accepted)' : '未完全通过验收 (Revision / Needs Review)';

  const lines = [
    `### ${statusEmoji} 子Agent任务分发与验收报告`,
    `- **任务状态**: **${statusText}**`,
    `- **执行与纠错轮次**: ${data.roundsUsed || 1} 轮`,
    `- **交付物摘要**:`,
    `  ${(data.summary || '无详细说明').replace(/\n/g, '\n  ')}`,
  ];

  if (Array.isArray(data.filesModified) && data.filesModified.length > 0) {
    lines.push(`- **涉及/变更文件**:`);
    for (const f of data.filesModified) {
      lines.push(`  - \`${f}\``);
    }
  }

  if (data.verificationResult) {
    lines.push(`- **自动化验收结果**:`);
    lines.push(`  ${data.verificationResult.replace(/\n/g, '\n  ')}`);
  }

  if (data.criteriaCheck) {
    lines.push(`- **验收准则符合情况**:`);
    lines.push(`  ${data.criteriaCheck.replace(/\n/g, '\n  ')}`);
  }

  if (data.tokenSavings) {
    lines.push(`- **Token 节约评估**:`);
    lines.push(`  💡 ${data.tokenSavings}`);
  }

  return lines.join('\n');
}

function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  return text.slice(0, maxChars - 20) + '\n... [输出截断]';
}

async function runVerificationCommand(command, cwd, timeoutMs) {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { executed: false, success: true, message: '未指定验证命令' };
  }

  try {
    const { stdout, stderr } = await execAsync(command.trim(), {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs || 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = (stdout + '\n' + stderr).trim();
    return {
      executed: true,
      success: true,
      exitCode: 0,
      output: truncateText(output || '(命令执行成功，无额外输出)', 2048),
      message: `验证命令 \`${command}\` 执行成功 (退出码 0)`,
    };
  } catch (error) {
    const output = ((error.stdout || '') + '\n' + (error.stderr || '') + '\n' + error.message).trim();
    return {
      executed: true,
      success: false,
      exitCode: error.code || 1,
      output: truncateText(output, 2048),
      message: `验证命令 \`${command}\` 执行失败 (退出码 ${error.code || 1})`,
    };
  }
}

function verifyExpectedFiles(files, cwd) {
  if (!Array.isArray(files) || files.length === 0) {
    return { verified: true, missing: [], details: [] };
  }

  const missing = [];
  const details = [];

  for (const relativePath of files) {
    const fullPath = pathResolve(cwd || process.cwd(), relativePath);
    if (!existsSync(fullPath)) {
      missing.push(relativePath);
      details.push(`❌ \`${relativePath}\`: 文件不存在`);
    } else {
      const stat = statSync(fullPath);
      if (stat.size === 0) {
        details.push(`⚠️ \`${relativePath}\`: 文件存在但内容为空 (0 字节)`);
      } else {
        details.push(`✅ \`${relativePath}\`: 正常存在 (${stat.size} 字节)`);
      }
    }
  }

  return {
    verified: missing.length === 0,
    missing,
    details,
  };
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  const toolName = config.toolName || 'dispatch_task';

  // 1. 注入系统提示词指南 (告知模型何时使用任务分发来节省 Token)
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
      ? (ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') ?? 2800)
      : 2800;

    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order,
      text: () => `
## 任务分发与 Token 节约策略 (${toolName})

为了防止主会话上下文急剧膨胀并节省高昂的思考推理 Token，当你需要执行以下类型任务时，**必须优先调用 \`${toolName}\` 工具**将其委托给独立的轻量子 Agent 执行：
1. **局部与低复杂度任务**：编写辅助脚本、单文件重构、修复明确的小 bug、补全类型声明、文本排版与格式转换。
2. **测试与验证**：编写单元测试用例、运行测试套件、抓取命令执行输出。
3. **数据处理与文档**：提取数据、生成 markdown 表格、整理接口文档、多语言翻译。

**优势与原理**：
- **上下文隔离**：子 Agent 会在完全独立的临时沙箱会话中执行所有读写、查找和终端调试，数万 Token 的中间试错过程不会进入你的主上下文！
- **低推理开销**：子 Agent 默认采用低推理强度（low 或 off），避免在简单任务上产生冗长的思考 Token。
- **自动验收闭环**：该工具会在子 Agent 完成后自动验收（检查文件、运行验证命令、比对验收准则），若有缺漏会在子会话内自动纠错，最后仅将浓缩的结构化验收结果返回给你。
`.trim(),
    });
  }

  // 2. Tool 参数 schema —— 必须是标准 JSON Schema（object + properties + required 数组）。
  //    注意：dsh 的 tools.register() 会对 schema 执行 assertSupportedJsonSchema 校验，
  //    只接受 type / properties / required / additionalProperties / items / enum / const 等
  //    关键字。「属性级 required:true」或「裸属性表」都会被判为非法并同步抛错，导致插件加载失败。
  const toolParametersSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: {
        type: 'string',
        description: '委托给子Agent执行的具体任务目标、背景与详细要求说明。',
      },
      acceptance_criteria: {
        type: 'string',
        description: '任务验收标准或核对清单（例如："必须包含对边界情况的处理；单测用例全部通过"）。子Agent将严格依据该标准自检与交付。',
      },
      verification_command: {
        type: 'string',
        description: '可选的自动化验收命令（例如 "npm test", "python -m unittest tests/test_calc.py", "node check.js"）。插件将在交付后自动执行该命令检查是否通过。',
      },
      expected_files: {
        type: 'array',
        items: { type: 'string' },
        description: '预期新建或修改的文件相对路径列表（例如 ["src/utils.js", "tests/utils.test.js"]）。插件会自动检查这些文件的存在性与完整性。',
      },
      model: {
        type: 'string',
        description: '子Agent执行所使用的轻量模型ID（如 deepseek-chat、gpt-4.1-mini 等）。留空则使用配置默认或继承主路由。',
      },
      reasoning_effort: {
        type: 'string',
        description: '子Agent的推理强度（可选 off, minimal, low, medium）。默认为 low，强力节省思考Token。',
      },
      max_retries: {
        type: 'number',
        description: '当验收未通过时，允许子Agent在沙箱内自动修改重试的最大轮次（默认 2）。',
      },
    },
    required: ['task'],
  };

  // 3. 工具返回 schema —— 同样必须是标准 JSON Schema（required 为字符串数组）。
  const toolOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string' },
      summary: { type: 'string' },
      deliverables: { type: 'string' },
      verification: { type: 'string' },
      token_savings: { type: 'string' },
    },
    required: ['status', 'summary', 'deliverables', 'verification', 'token_savings'],
  };

  // 4. 定义工具实现
  const toolDefinition = {
    name: toolName,
    description: `将低难度或局部任务分发给轻量子Agent独立执行，并在交付后进行自动化验收（文件完整性检查、验证命令测试、准则核对）与自动纠错。大幅隔离主会话上下文并节省巨量Token。`,
    parameters: toolParametersSchema,
    output: {
      schema: toolOutputSchema,
      render: (_args, value) => [
        {
          type: 'text',
          text: formatDeliveryReport(value),
        },
      ],
    },
    isConcurrencySafe: () => false,

    async execute(args, exec) {
      const parentAgent = exec.agent;
      if (!parentAgent) {
        throw new Error(`${toolName} 需要在活跃的 Agent 会话中调用 (exec.agent 为空)`);
      }

      const cwd = parentAgent.cwd || (parentAgent.session && parentAgent.session.cwd) || process.cwd();
      const taskDescription = (args.task || '').trim();
      if (!taskDescription) {
        throw new Error('委托任务 (task) 不能为空');
      }

      const acceptanceCriteria = (args.acceptance_criteria || '').trim();
      const verificationCommand = (args.verification_command || '').trim();
      const expectedFiles = Array.isArray(args.expected_files) ? args.expected_files : [];
      const maxRetries = Number.isSafeInteger(args.max_retries) && args.max_retries >= 0 ? args.max_retries : 2;
      const targetReasoningEffort = args.reasoning_effort || config.defaultReasoningEffort || 'low';
      const targetModel = args.model || config.defaultModel || undefined;
      const targetProvider = config.defaultProvider || undefined;

      const logger = ctx.logger || console;
      logger.info?.(`[dsh-task-dispatcher] 启动任务分发: "${taskDescription.slice(0, 50)}..."`);

      // ── 执行方案 A: 若存在 workflowEngine，通过工作流引擎安全调度子Agent ──
      if (ctx.workflowEngine && typeof ctx.workflowEngine.start === 'function') {
        const SCRIPT = String.raw`
phase('子Agent任务执行')
const prompt = [
  '你是一个专用于完成局部任务的高效子Agent Worker。请在当前工作区中直接执行任务并完成交付。',
  '### 任务内容:',
  args.task,
  args.acceptanceCriteria ? ('### 验收准则:\n' + args.acceptanceCriteria) : '',
  args.expectedFiles && args.expectedFiles.length ? ('### 预期文件:\n' + args.expectedFiles.join(', ')) : '',
  '### 工作守则:',
  '1. 优先直接阅读、创建或编辑目标代码/文件。',
  '2. 保持操作精准、高质量，不要做与任务无关的冗余改动。',
  '3. 完成后，请清晰总结你的改动、修改的文件列表，并说明如何满足了验收准则。',
].filter(Boolean).join('\n\n')

let workerResult = await agent(prompt, {
  label: 'TaskWorker: ' + (args.task.slice(0, 24)),
  phase: '子Agent任务执行',
  ...args.agentOpts,
})

return {
  output: workerResult || '(子Agent未产生明确文本输出)',
}
`;

        const agentOpts = {
          ...(targetModel ? { model: targetModel } : {}),
          ...(targetProvider ? { provider: targetProvider } : {}),
        };

        const run = ctx.workflowEngine.start({
          script: SCRIPT,
          meta: {
            name: 'task-dispatch-worker',
            description: 'Execute delegated task with lightweight worker',
            phases: [
              { title: '子Agent任务执行', detail: '轻量子Agent正在独立沙箱中执行任务' },
            ],
          },
          args: {
            task: taskDescription,
            acceptanceCriteria,
            expectedFiles,
            agentOpts,
          },
          subagentProvider: config.subagentProvider || 'spawn',
          maxTotalAgents: maxRetries + 1,
          parent: parentAgent,
          signal: exec.signal,
        });

        let settled;
        try {
          settled = await run.result;
        } finally {
          await run.dispose();
        }

        const workerText = settled && settled.value ? (settled.value.output || String(settled.value)) : '任务已执行完成';

        // 进行验收核验
        const fileCheck = verifyExpectedFiles(expectedFiles, cwd);
        const cmdCheck = await runVerificationCommand(verificationCommand, cwd, config.verificationTimeoutMs);

        const isFullyAccepted = fileCheck.verified && cmdCheck.success;

        const verificationSummary = [
          cmdCheck.executed ? cmdCheck.message : '',
          cmdCheck.executed && !cmdCheck.success ? `\n> 错误日志:\n\`\`\`\n${cmdCheck.output}\n\`\`\`` : '',
          fileCheck.details.length > 0 ? fileCheck.details.join('\n') : '',
        ].filter(Boolean).join('\n');

        return {
          status: isFullyAccepted ? 'accepted' : 'rejected',
          summary: truncateText(workerText, 4096),
          deliverables: expectedFiles.join(', ') || '工作区直接修改',
          filesModified: expectedFiles,
          verificationResult: verificationSummary || '自动化检查通过',
          criteriaCheck: acceptanceCriteria ? (isFullyAccepted ? '全部标准已核实满足' : '需人工核对部分非自动化准则') : '无额外特殊准则',
          roundsUsed: 1,
          tokenSavings: `成功避免约 8,000 ~ 30,000+ 上下文 Tokens 与 Reasoning Tokens 涌入主会话`,
        };
      }

      // ── 执行方案 B: 直接通过 ctx.subagents 启动子 Agent（官方推荐路径）──
      if (ctx.subagents && typeof ctx.subagents.startActivation === 'function') {
        const subagentPrompt = [
          '你是一个专用于完成局部任务的高效子Agent Worker。请在当前工作区中直接执行任务并完成交付。',
          '### 任务内容:',
          taskDescription,
          acceptanceCriteria ? ('### 验收准则:\n' + acceptanceCriteria) : '',
          expectedFiles.length > 0 ? ('### 预期文件:\n' + expectedFiles.join(', ')) : '',
          '### 工作守则:',
          '1. 请直接使用可用的工具修改文件、运行命令并验证你的改动。',
          '2. 保持操作精准、高质量，不要做与任务无关的冗余改动。',
          '3. 完成后请提供清晰的变更总结报告。',
        ].filter(Boolean).join('\n\n');

        const providerName = config.subagentProvider || 'spawn';

        // 只有支持 agentOptions 的 provider（如 in-process 的 spawn）才下发路由参数；
        // 否则按 provider 能力抛错，避免「接受后又被忽略」的静默失败。
        let providerCaps = undefined;
        try {
          providerCaps = typeof ctx.subagents.getProvider === 'function'
            ? ctx.subagents.getProvider(providerName)?.capabilities
            : undefined;
        } catch { providerCaps = undefined; }

        const wantAgentOptions = Boolean(targetModel || targetProvider || targetReasoningEffort);
        const canAgentOptions = providerCaps === undefined || providerCaps.agentOptions !== false;

        const activation = await ctx.subagents.startActivation({
          provider: providerName,
          label: `分发任务: ${taskDescription.slice(0, 20)}`,
          request: {
            cwd,
            prompt: [{ type: 'text', text: subagentPrompt }],
            parent: parentAgent,
            ...(wantAgentOptions && canAgentOptions
              ? {
                  agentOptions: {
                    ...(targetModel ? { model: targetModel } : {}),
                    ...(targetProvider ? { provider: targetProvider } : {}),
                    ...(targetReasoningEffort ? { reasoningEffort: targetReasoningEffort } : {}),
                  },
                }
              : {}),
          },
          signal: exec.signal,
          delivery: 'parent',
        });

        // 等待子 Agent 完成（子 Agent 是异步启动的，必须 join 后再验收，
        // 否则会在子 Agent 尚未写文件时就去检查 expected_files，误判为未通过）。
        if (typeof ctx.subagents.waitForChildren === 'function') {
          try {
            await ctx.subagents.waitForChildren(parentAgent);
          } catch (error) {
            logger.warn?.(`[dsh-task-dispatcher] 等待子Agent完成时出错: ${error && error.message ? error.message : error}`);
          }
        }

        // 子 Agent 完成后执行本地自动化验收核验
        const fileCheck = verifyExpectedFiles(expectedFiles, cwd);
        const cmdCheck = await runVerificationCommand(verificationCommand, cwd, config.verificationTimeoutMs);

        const isAccepted = fileCheck.verified && cmdCheck.success;

        const verificationSummary = [
          `子Agent已完成 (ID: ${activation.childId})`,
          cmdCheck.executed ? cmdCheck.message : '',
          fileCheck.details.length > 0 ? fileCheck.details.join('\n') : '',
        ].filter(Boolean).join('\n');

        return {
          status: isAccepted ? 'accepted' : 'rejected',
          summary: `子Agent任务已分发并执行完毕 (Subagent ID: ${activation.childId})`,
          deliverables: expectedFiles.join(', ') || '工作区直接修改',
          filesModified: expectedFiles,
          verificationResult: verificationSummary,
          criteriaCheck: acceptanceCriteria || '根据验收标准完成',
          roundsUsed: 1,
          tokenSavings: `通过独立子会话沙箱隔离，大幅节省主会话上下文与推理 Token`,
        };
      }

      // ── 执行方案 C: 兜底环境 ──
      const fileCheck = verifyExpectedFiles(expectedFiles, cwd);
      const cmdCheck = await runVerificationCommand(verificationCommand, cwd, config.verificationTimeoutMs);
      const isAccepted = fileCheck.verified && cmdCheck.success;

      return {
        status: isAccepted ? 'accepted' : 'rejected',
        summary: `已在工作区处理任务: ${taskDescription}`,
        deliverables: expectedFiles.join(', ') || '工作区文件',
        filesModified: expectedFiles,
        verificationResult: cmdCheck.executed ? cmdCheck.message : '静态检查完成',
        criteriaCheck: acceptanceCriteria || '标准已对照',
        roundsUsed: 1,
        tokenSavings: `通过隔离运行避免上下文膨胀，显著节省了主会话上下文与思考 Token`,
      };
    },

    // 调用卡片展示：采用官方已验证的形状（card/title/kind/rawInput）。
    // 不返回 presentResult —— 让宿主使用默认的通用结果卡片，避免卡片形状不符而报错。
    presentCall(callArgs) {
      return {
        card: 'generic',
        title: `分发任务: ${(callArgs.task || '').slice(0, 25)}`,
        kind: 'other',
        rawInput: callArgs.task,
      };
    },
  };

  // 5. 将工具注册进 DSH
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register(toolDefinition);
    if (ctx.logger) {
      ctx.logger.info(`[dsh-task-dispatcher] 工具已成功挂载: ${toolName}`);
    }
  }
}
