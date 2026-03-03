---
name: aosp-mcp-workflow
description: Run AOSP-oriented MCP setup and operations with a repeatable workflow. Use when configuring or operating lsp-mcp-server for AOSP, including stdio integration, compile_commands/module-info checks, preset-based indexing (audio/driver/system_server), module indexing, and daily symbol/class/path queries with guardrails.
---

# AOSP MCP Workflow

Use this skill when the user needs a practical workflow, not raw API details.

## Execute

1. Verify runtime prerequisites before any query workflow:
- `WORKSPACE_ROOT` points to AOSP root.
- `LSP_MCP_CONFIG` points to active config.
- `module-info.json` exists in build outputs.
- `compile_commands.json` exists for C/C++ semantic quality.

2. Run guided initialization from [references/init.md](references/init.md) when:
- First-time setup.
- Machine path changed.
- AOSP source synced/rebuilt significantly.

3. Run daily operations from [references/daily-workflow.md](references/daily-workflow.md) when:
- User asks to locate symbols/classes/modules quickly.
- User asks for low-latency code search in limited areas.

4. Prefer preset flow when role is obvious:
- Audio engineer: use `audio` preset.
- Driver/HAL engineer: use `driver` preset.
- Framework service engineer: use `system_server` preset.
- See [references/presets.md](references/presets.md).

5. Enforce guardrails:
- Never run unconstrained whole-root text search.
- Prefer `indexPreset` or `indexModule` before repeated queries.
- Use `queryPresetSymbol`/`queryIndexedSymbol` for frequent tasks.

## Output Contract

When executing this skill, always return:

1. Current environment check result (paths + required artifacts).
2. Exact MCP operations executed (or ready-to-run sequence).
3. If preset is used: preset name, indexed module count, and follow-up query example.
4. If blocked: missing artifact + the minimal fix command/path.

## References

- Initialization checklist and one-time setup: [references/init.md](references/init.md)
- Day-to-day operation flow: [references/daily-workflow.md](references/daily-workflow.md)
- Preset catalog and role mapping: [references/presets.md](references/presets.md)
- Command cookbook and call payloads: [references/examples.md](references/examples.md)
