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
      ['deliverables', 'status', 'summary', 'token_savings', 'verification'],
    );
    assert.strictEqual(typeof registeredTool.output.render, 'function');
    const blocks = registeredTool.output.render({}, {
      status: 'accepted',
      summary: 'done',
      deliverables: 'f.js',
      verification: 'ok',
      token_savings: 'saved',
      filesModified: ['f.js'],
      roundsUsed: 1,
    });
    assert.ok(Array.isArray(blocks));
    assert.strictEqual(blocks[0].type, 'text');
    assert.ok(blocks[0].text.includes('验收'));

    // presentCall must match the first-party shape.
    const call = registeredTool.presentCall({ task: 'do something' });
    assert.strictEqual(call.card, 'generic');
    assert.strictEqual(call.kind, 'other');
  });

  it('should execute automated checks and verification commands', async () => {
    let registeredTool = null;
    const mockCtx = {
      tools: { register: (tool) => { registeredTool = tool; } },
      systemPrompt: { section: () => {}, getSectionOrder: () => 2800 },
    };

    apply(mockCtx);

    const testFile = resolve(process.cwd(), 'temp-verify-test.txt');
    writeFileSync(testFile, 'hello verification', 'utf8');

    try {
      const mockExec = { agent: { cwd: process.cwd() } };
      const result = await registeredTool.execute(
        {
          task: '测试局部文件与命令验证',
          expected_files: ['temp-verify-test.txt'],
          verification_command: 'node -e "process.exit(0)"',
        },
        mockExec,
      );

      assert.strictEqual(result.status, 'accepted');
      assert.ok(result.verificationResult.includes('执行成功'));
      assert.ok(result.tokenSavings.includes('节省'));
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
    }
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
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
    }
  });
});
