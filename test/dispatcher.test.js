import { describe, it } from 'node:test';
import assert from 'node:assert';
import { apply, name, inject } from '../lib/index.js';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal replica of the harness `assertSupportedJsonSchema` subset rules that
 * matter for tool registration: object root, `required` must be a string array,
 * and no per-property `required` key (that is what breaks `tools.register`).
 * Structural check only — it keeps the schema from regressing to a shape the
 * real host rejects.
 */
function assertHarnessCompatibleSchema(schema, path = 'schema') {
  assert.ok(schema && typeof schema === 'object', `${path} must be an object`);
  for (const key of Object.keys(schema)) {
    assert.ok(
      ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'].includes(key),
      `${path}.${key} is not a supported keyword`,
    );
  }
  if (Object.hasOwn(schema, 'required')) {
    assert.ok(Array.isArray(schema.required), `${path}.required must be an array`);
    assert.ok(schema.required.every((k) => typeof k === 'string'), `${path}.required must be strings`);
  }
  if (schema.type === 'object') {
    assert.ok(schema.properties && typeof schema.properties === 'object', `${path}.properties must exist`);
    for (const [key, child] of Object.entries(schema.properties)) {
      assert.ok(!Object.hasOwn(child, 'required'), `${path}.properties.${key} must not use per-property required`);
      assertHarnessCompatibleSchema(child, `${path}.properties.${key}`);
    }
  }
  if (schema.type === 'array') {
    assert.ok(schema.items, `${path}.items must exist`);
    assertHarnessCompatibleSchema(schema.items, `${path}.items`);
  }
}

/**
 * Mirrors the host's runtime output validation (`createSuccessResult`):
 *   validateJsonSchemaValue(tool.output.schema, value)
 * A failure here is exactly what makes the host throw `ToolOutputError` after a
 * successful tool call, so this guards the schema-vs-return-value contract.
 */
function assertValueMatchesSchema(schema, value, path = 'value') {
  const typeOk = {
    string: (v) => typeof v === 'string',
    number: (v) => typeof v === 'number',
    boolean: (v) => typeof v === 'boolean',
    array: (v) => Array.isArray(v),
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  };
  assert.ok(typeOk[schema.type]?.(value), `${path} is not of type ${schema.type} (got ${JSON.stringify(value)})`);
  if (schema.type === 'object') {
    for (const req of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, req), `missing required property "${path}.${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        assert.ok(k in schema.properties, `"${path}.${k}" is not a declared property`);
      }
    }
    for (const [k, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, k)) assertValueMatchesSchema(child, value[k], `${path}.${k}`);
    }
  }
  if (schema.type === 'array') {
    value.forEach((item, i) => assertValueMatchesSchema(schema.items, item, `${path}[${i}]`));
  }
}

describe('dsh-task-dispatcher plugin test suite', () => {
  it('should export correct plugin metadata', () => {
    assert.strictEqual(name, 'dsh-task-dispatcher');
    assert.deepStrictEqual(inject, ['tools', 'systemPrompt', 'subagents']);
    assert.strictEqual(typeof apply, 'function');
  });

  it('should register tool and system prompt section with harness-compatible schemas', () => {
    let registeredTool = null;
    let registeredSection = null;

    const mockCtx = {
      tools: {
        register: (tool) => {
          registeredTool = tool;
        },
      },
      systemPrompt: {
        section: (section) => {
          registeredSection = section;
        },
        getSectionOrder: () => 2800,
      },
      logger: { info: () => {}, warn: () => {} },
    };

    apply(mockCtx, { toolName: 'dispatch_task' });

    // System prompt
    assert.ok(registeredSection, 'System prompt section should be registered');
    assert.strictEqual(registeredSection.name, 'tool:dispatch_task');
    assert.strictEqual(registeredSection.order, 2800);
    const promptText = registeredSection.text();
    assert.ok(promptText.includes('任务分发与 Token 节约策略'));
    assert.ok(promptText.includes('dispatch_task'));

    // Tool
    assert.ok(registeredTool, 'Tool should be registered');
    assert.strictEqual(registeredTool.name, 'dispatch_task');

    // The schema shape the host actually accepts.
    assertHarnessCompatibleSchema(registeredTool.parameters, 'parameters');
    assert.strictEqual(registeredTool.parameters.type, 'object');
    assert.deepStrictEqual(registeredTool.parameters.required, ['task']);
    assert.strictEqual(registeredTool.parameters.properties.task.type, 'string');
    assert.ok(registeredTool.parameters.properties.expected_files);
    assert.ok(registeredTool.parameters.properties.acceptance_criteria);
    assert.ok(registeredTool.parameters.properties.verification_command);

    // Output schema + render contract.
    assertHarnessCompatibleSchema(registeredTool.output.schema, 'output.schema');
    assert.deepStrictEqual(
      [...registeredTool.output.schema.required].sort(),
      ['criteriaCheck', 'deliverables', 'filesModified', 'roundsUsed', 'status', 'summary', 'tokenSavings', 'verificationResult'],
    );
    assert.strictEqual(typeof registeredTool.output.render, 'function');
    const blocks = registeredTool.output.render({}, {
      status: 'accepted',
      summary: 'done',
      deliverables: 'f.js',
      filesModified: ['f.js'],
      verificationResult: 'ok',
      criteriaCheck: 'met',
      roundsUsed: 1,
      tokenSavings: 'saved',
    });
    assert.ok(Array.isArray(blocks));
    assert.strictEqual(blocks[0].type, 'text');
    assert.ok(blocks[0].text.includes('验收'));

    // presentCall must match the first-party shape.
    const call = registeredTool.presentCall({ task: 'do something' });
    assert.strictEqual(call.card, 'generic');
    assert.strictEqual(call.kind, 'other');
  });

  it('should throw clear error when subagents service is missing', async () => {
    let registeredTool = null;
    const mockCtx = {
      tools: { register: (tool) => { registeredTool = tool; } },
      systemPrompt: { section: () => {}, getSectionOrder: () => 2800 },
    };

    apply(mockCtx);

    const mockExec = { agent: { cwd: process.cwd() } };
    await assert.rejects(
      async () => {
        await registeredTool.execute(
          {
            task: '测试缺少服务时报错',
          },
          mockExec,
        );
      },
      /缺少 subagents 服务/,
    );
  });

  it('should dispatch to a subagent, wait for it, then verify', async () => {
    let registeredTool = null;
    const calls = { started: 0, waited: 0, args: null };
    const mockCtx = {
      tools: { register: (tool) => { registeredTool = tool; } },
      systemPrompt: { section: () => {}, getSectionOrder: () => 2800 },
      logger: { info: () => {}, warn: () => {} },
      subagents: {
        getProvider: () => ({ capabilities: { agentOptions: true } }),
        startActivation: async (spec) => {
          calls.started += 1;
          calls.args = spec;
          return { childId: 'child-123' };
        },
        waitForChildren: async () => {
          calls.waited += 1;
          return true;
        },
      },
    };

    apply(mockCtx, { subagentProvider: 'spawn' });

    const testFile = resolve(process.cwd(), 'temp-subagent-test.txt');
    writeFileSync(testFile, 'subagent output', 'utf8');
    try {
      const result = await registeredTool.execute(
        {
          task: '让子Agent写一个文件',
          expected_files: ['temp-subagent-test.txt'],
          reasoning_effort: 'low',
        },
        { agent: { cwd: process.cwd() } },
      );

      assert.strictEqual(calls.started, 1, 'startActivation should be called once');
      assert.strictEqual(calls.waited, 1, 'waitForChildren must run before acceptance');
      assert.strictEqual(calls.args.provider, 'spawn');
      assert.strictEqual(calls.args.delivery, 'parent');
      assert.strictEqual(calls.args.request.parent, mockCtx.__agent ?? calls.args.request.parent);
      assert.ok(Array.isArray(calls.args.request.prompt));
      assert.strictEqual(calls.args.request.agentOptions.reasoningEffort, 'low');
      assert.strictEqual(result.status, 'accepted');
      // 返回对象必须通过 output.schema 校验（否则宿主抛 ToolOutputError）
      assertValueMatchesSchema(registeredTool.output.schema, result);
      assert.strictEqual(typeof result.verificationResult, 'string');
      assert.strictEqual(typeof result.tokenSavings, 'string');
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
    }
  });

  it('should retry with feedback when the first attempt fails acceptance', async () => {
    let registeredTool = null;
    const prompts = [];
    let attempt = 0;
    const fileName = 'temp-retry-test.txt';
    const testFile = resolve(process.cwd(), fileName);
    if (existsSync(testFile)) unlinkSync(testFile);

    const mockCtx = {
      tools: { register: (tool) => { registeredTool = tool; } },
      systemPrompt: { section: () => {}, getSectionOrder: () => 2800 },
      logger: { info: () => {}, warn: () => {} },
      subagents: {
        getProvider: () => ({ capabilities: { agentOptions: true } }),
        startActivation: async (spec) => {
          attempt += 1;
          prompts.push(spec.request.prompt[0].text);
          // 第 2 轮才把文件写出来，模拟第 1 轮交付不合格
          if (attempt >= 2) writeFileSync(testFile, 'fixed', 'utf8');
          return { childId: `child-${attempt}` };
        },
        waitForChildren: async () => true,
      },
    };

    apply(mockCtx, { maxRounds: 1 });
    try {
      const result = await registeredTool.execute(
        { task: '写一个文件（第一轮故意不写）', expected_files: [fileName], max_retries: 1 },
        { agent: { cwd: process.cwd() } },
      );

      assert.strictEqual(attempt, 2, '应在首次失败后重试一次');
      assert.strictEqual(result.roundsUsed, 2);
      assert.strictEqual(result.status, 'accepted');
      assert.ok(prompts[1].includes('验收未通过'), '第二轮提示词应包含失败反馈');
      assertValueMatchesSchema(registeredTool.output.schema, result);
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
    }
  });
});
