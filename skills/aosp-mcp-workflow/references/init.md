# 初始化流程

## 目标

在新机器或新 AOSP 工作区中，把 `lsp-mcp-server` 以 `stdio` 方式稳定跑起来，并具备 AOSP 检索能力。

## 步骤

1. 构建服务
- 进入 `lsp-mcp-server`
- 执行 `npm install && npm run build`

2. 放置配置
- MCP 配置使用 `claude-code-mcp.aosp.template.json`
- LSP 配置使用 `lsp-mcp-config.aosp.template.json`
- 将其中路径替换为真实路径

3. 校验关键环境
- `WORKSPACE_ROOT` 指向 AOSP 根目录
- `LSP_MCP_CONFIG` 指向有效 json 文件
- `module-info.json` 可读（例如 `out/soong/module-info.json`）
- `compile_commands.json` 可读（例如 `out/target/ide/compiledb/compile_commands.json`）

4. 重启 ClaudeCode 后验证
- `aosp.detectRoot`
- `aosp.listPresets`
- `aosp.indexPreset`（任选一个，如 `audio`）
- `aosp.queryPresetSymbol`（验证结果非空）

## 判定成功

- `detectRoot.isAospLike` 为 `true`
- `indexPreset` 返回 `indexedModules` 非空
- `queryPresetSymbol` 返回至少 1 条结果
