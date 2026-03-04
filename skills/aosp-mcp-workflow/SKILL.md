---
name: aosp-mcp-workflow
description: 使用可复用流程执行 AOSP 场景下的 MCP 初始化与检索操作。适用于配置或日常使用 lsp-mcp-server，包括 stdio 接入、compile_commands/module-info 检查、按领域增量索引（audio/video/render）、按预设索引（audio/driver/system_server）、模块索引，以及带约束的日常符号/类型/路径检索。
---

# AOSP MCP 工作流

当用户需要可执行流程而不是底层 API 细节时，使用本技能。

## 执行步骤

1. 在执行任何检索前，先检查运行前提：
- `WORKSPACE_ROOT` 指向 AOSP 根目录。
- `LSP_MCP_CONFIG` 指向当前生效配置。
- 构建产物中存在 `module-info.json`。
- 存在 `compile_commands.json` 以保证 C/C++ 语义质量。

2. 下面场景需按 [references/init.md](references/init.md) 执行初始化：
- 首次搭建环境。
- 机器路径变更。
- AOSP 源码有较大同步或重编译。

3. 下面场景按 [references/daily-workflow.md](references/daily-workflow.md) 执行日常流程：
- 用户要快速定位符号/类型/模块。
- 用户要在受限范围内低延迟检索代码。

4. 优先使用最简两命令流：
- 先执行一次 `aosp.init`（产物检查 + 领域推断 + 建索引）。
- 日常统一使用 `aosp.search`（自动领域 + 递进路由）。

5. 若用户角色明确且需要更大跨仓覆盖，使用预设/领域高级流：
- 音频工程师：`audio` 预设。
- 驱动/HAL 工程师：`driver` 预设。
- Framework 服务工程师：`system_server` 预设。
- 详见 [references/presets.md](references/presets.md)。

6. 严格执行约束策略：
- 禁止无约束全仓文本扫描。
- 高频重复检索前优先执行 `indexPreset` 或 `indexModule`。
- 日常优先 `search`，再按需使用 `queryDomain`/`queryPresetSymbol`/`queryIndexedSymbol`。

## 输出约定

执行本技能时，始终输出：

1. 当前环境检查结果（路径 + 必需产物）。
2. 已执行的 MCP 操作（或可直接执行的顺序）。
3. 若使用 init/search：给出选定领域、索引数量和后续 `search` 示例。
4. 若使用预设：给出预设名、索引模块数和后续查询示例。
5. 若被阻塞：给出缺失产物和最小修复命令/路径。

## 参考文档

- 初始化清单与一次性配置：[references/init.md](references/init.md)
- 日常操作流程：[references/daily-workflow.md](references/daily-workflow.md)
- 预设目录与角色映射：[references/presets.md](references/presets.md)
- 命令示例与调用参数：[references/examples.md](references/examples.md)
