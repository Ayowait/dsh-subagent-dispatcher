# Changelog

All notable changes to `dsh-subagent-dispatcher` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-31

### Changed
- **重命名：`dsh-task-dispatcher` → `dsh-subagent-dispatcher`**。原名称与另一位作者的插件（`zhengjy01/dsh-task-dispatcher`，基于滴答清单的每日任务调度器）重名，且该名称在 npm 上已被其占用。为彻底避免混淆与误装，本项目更名。
- 跟随更名更新：`package.json` 包名、`cordis.patch.yml` 的 `id`/`name`、`export const name`、系统提示词标识、`install.ps1` 的 `$PluginName`、README / README.zh 的标题与安装命令、`src/*` 与测试文件中的标识。
- **安装方式**：`dsh plugin add github:Ayowait/dsh-subagent-dispatcher`（或直接 `dsh plugin add dsh-subagent-dispatcher`，npm 包名现已归本项目所有）。

## [1.0.1] - 2026-10-29

### Fixed
- **P0: 标准 JSON Schema 适配**：重构 `parameters` 和 `output.schema`，使用宿主 `assertSupportedJsonSchema()` 校验认可的标准 object 节点与 object 级 `required` 字符串数组，彻底解决 `tools.register()` 同步抛错崩溃问题。
- **P0: 返回 schema 与返回值对齐（关键）**：`output.schema` 原先把字段写成 `verification` / `token_savings`（snake_case），而 `execute()` 实际返回 `verificationResult` / `tokenSavings` / `filesModified` 等 camelCase 字段。宿主 `createSuccessResult()` 会用 `validateJsonSchemaValue(output.schema, 返回值)` 校验，不符即 `throw ToolOutputError`，导致**每次成功调用都报错**。现已按真实返回对象逐字段校准，并在测试中加入返回值↔schema 一致性断言，防止再次漂移。
- **P0: 异步子 Agent 完成等待**：在启动子 Agent 后增加 `ctx.subagents.waitForChildren(parentAgent)`，彻底解决异步启动未完成即抢跑验收判定导致的误判 `rejected` 问题。
- **P0: 补充服务依赖声明**：在 Cordis `inject` 中显式声明 `subagents` 依赖项（`['tools', 'systemPrompt', 'subagents']`）。
- **P1: 动态探测 Provider 能力**：通过 `getProvider()?.capabilities` 动态探测子 Agent 宿主能力，仅在支持时下发 `agentOptions`（`model / provider / reasoningEffort`），杜绝参数被静默忽略。
- **P1: 清理死代码分支**：彻底移除 DSH 1.x 中不存在的 `workflowEngine.start` 死代码分支，保持执行路径极简纯粹。
- **P1: 真正实现自动纠错闭环**：`max_retries` / `maxRounds` 不再是死配置。首次执行验收未通过时，会把「缺失文件 / 验证命令失败输出」回灌进下一轮子 Agent 提示词，进行有上限的针对性重试，`roundsUsed` 如实记录实际轮次。`autoVerifyFiles` 开关也已真正接入。
- **P1: 严谨的兜底错误诊断**：在缺失 `subagents` 服务时主动抛出明确的诊断报错，避免假装 `accepted` 误导主模型。
- **P2: 规范化调用卡片**：`presentCall` 补齐官方卡片 `kind: 'other'` 字段，删除非标的 `presentResult`，交由宿主默认卡片渲染。
- **P2: 系统提示词槽位对齐**：系统提示词 order 兜底采用 DSH 官方 `TOOL_SUBAGENT` 槽位（2800）。
- **P2: 文档脱敏与规范化**：清理 README 中所有机器特定的绝对路径，准确客观描述一次性自动验收流程，杜绝虚假夸大描述。
- **P2: 单元测试套件升级**：重构 `test/dispatcher.test.js`，包含 4 组完整用例：元数据检查、宿主 JSON Schema 合规性深度巡检、缺失服务抛错检查、子 Agent 异步等待与核验全流程。
- **清理无用 Peer 依赖**：移除 `package.json` 中多余的 `@deepseek-ai/*` peer 依赖声明，零外部依赖，极速开箱即用。

## [1.0.0] - 2026-10-29

### Added
- **Initial Release of `dsh-subagent-dispatcher`** for DeepSeek Harness (DSH).
- **Core Dispatch Tool (`dispatch_task`)**:
  - Automatically offload scoped, low-complexity, or routine tasks to isolated sub-agents.
  - Supports configurable parameters: `task`, `acceptance_criteria`, `verification_command`, `expected_files`, `model`, `reasoning_effort`, `max_retries`.
- **Automated Acceptance & Verification Engine**:
  - Automated command execution verification (e.g. `npm test`, `python -m unittest`, `node check.js`) with zero model token cost.
  - File existence and integrity verification for `expected_files`.
- **Deep Token & Context Optimization**:
  - Context isolation: Prevents massive exploration and command tool logs from polluting the parent conversation.
  - Reasoning effort downgrade: Subagents default to `low` or `off` reasoning effort, saving up to 80%+ reasoning tokens.
  - Condensed handoff: Main conversation only receives structured, concise acceptance reports.
- **One-click Installer (`install.ps1`)**:
  - Automated registration into `~/.dsh/profiles/desktop/package.json` and `cordis.patch.yml`.
  - Full backup creation and safe `-Uninstall` rollback support.
