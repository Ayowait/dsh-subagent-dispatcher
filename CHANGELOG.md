# Changelog

All notable changes to `dsh-task-dispatcher` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-29

### Added
- **Initial Release of `dsh-task-dispatcher`** for DeepSeek Harness (DSH).
- **Core Dispatch Tool (`dispatch_task`)**:
  - Automatically offload scoped, low-complexity, or routine tasks to isolated sub-agents.
  - Supports configurable parameters: `task`, `acceptance_criteria`, `verification_command`, `expected_files`, `model`, `reasoning_effort`, `max_retries`.
- **Automated Acceptance & Verification Engine**:
  - Automated command execution verification (e.g. `npm test`, `python -m unittest`, `node check.js`) with zero model token cost.
  - File existence and integrity verification for `expected_files`.
  - In-sandbox revision feedback loop when acceptance criteria are not met.
- **Deep Token & Context Optimization**:
  - Context isolation: Prevents massive exploration and command tool logs from polluting the parent conversation.
  - Reasoning effort downgrade: Subagents default to `low` or `off` reasoning effort, saving up to 80%+ reasoning tokens.
  - Condensed handoff: Main conversation only receives structured, concise acceptance reports.
- **DSH Ecosystem Integration**:
  - Native Cordis plugin lifecycle (`apply(ctx, config)`).
  - Cordis loader patch support (`cordis.patch.yml`).
  - System prompt guidance injection into `ctx.systemPrompt`.
  - Dual execution engines: Primary via `ctx.workflowEngine`, fallback via `ctx.subagents`.
- **One-click Installer (`install.ps1`)**:
  - Automated registration into `~/.dsh/profiles/desktop/package.json` and `cordis.patch.yml`.
  - Full backup creation and safe `-Uninstall` rollback support.

### Fixed
- **Tool schema now matches the harness-enforced JSON Schema subset.** `ctx.tools.register()`
  runs `assertSupportedJsonSchema()` synchronously; per-property `required: true` (and a bare
  property map passed as `parameters`) made registration throw, so the plugin failed to load.
  Both `parameters` and `output.schema` are now proper object-rooted JSON Schemas with a
  `required` string array.
- **Subagent completion is awaited.** The dispatch path now calls
  `ctx.subagents.waitForChildren(parent)` before running acceptance checks, so automatic file
  and command verification no longer races the asynchronous child and falsely reports failure.
- **Provider capability is respected** (`agentOptions` is only sent when the provider supports
  it) and the `subagents` service is declared in `inject`.
- **Presentation callbacks use the first-party shape** (`presentCall`: `card/title/kind/rawInput`);
  the malformed `presentResult` card was removed in favour of the default result card.
- **System-prompt section order** falls back to the official `TOOL_SUBAGENT` slot (2800) instead
  of an off-table value, and README installation examples no longer embed machine-specific
  absolute paths.

