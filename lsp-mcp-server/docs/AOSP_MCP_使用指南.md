# AOSP MCP 使用指南

本文是 `lsp-mcp-server` 在 AOSP 场景下的实操说明，重点覆盖：

- 如何接入 ClaudeCode（stdio）
- `aosp` 工具如何按模块工作
- `aosp` 预设如何按角色一键启用
- `lsp` 工具如何结合 `clangd` 使用
- 常见问题排查

## 1. 快速接入（stdio）

1. 安装并构建：

```bash
cd lsp-mcp-server
npm install
npm run build
```

2. ClaudeCode MCP 配置（示例）：

```json
{
  "mcpServers": {
    "lsp-aosp": {
      "command": "node",
      "args": ["D:/Codes/claude-work/lsp-mcp-server/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "D:/AOSP",
        "LSP_MCP_CONFIG": "D:/AOSP/lsp-mcp-config.json"
      }
    }
  }
}
```

3. 准备 `lsp-mcp-config.json`（建议从模板复制）：

- 根目录模板：`lsp-mcp-config.aosp.template.json`
- 关键点：`clangd` 建议加 `--compile-commands-dir=out/target/ide/compiledb`

## 2. 工具分工

- `aosp`：AOSP 特化检索与模块定位（强约束，不全仓裸扫）
- `lsp`：语义能力（definition/references/hover 等）

推荐顺序：

1. 先 `aosp.detectRoot`
2. 再 `aosp.listPresets` 选择预设（或走手工模块）
3. `aosp.indexPreset`（或 `aosp.indexModule`）
4. 之后用 `aosp.queryPresetSymbol` / `aosp.queryIndexedSymbol` 快速定位
4. 最后对具体文件位置用 `lsp.goToDefinition` 等做语义跳转

## 3. aosp 工具操作说明

### 3.1 detectRoot

用途：探测 AOSP 根目录是否识别正确。

```json
{"name":"aosp","arguments":{"operation":"detectRoot"}}
```

### 3.2 resolveModule

用途：从 `module-info.json` 解析模块对应源码路径。

```json
{"name":"aosp","arguments":{"operation":"resolveModule","moduleName":"services.core"}}
```

### 3.3 indexModule

用途：对单模块建立局部索引分片（推荐先做这一步）。

```json
{"name":"aosp","arguments":{"operation":"indexModule","moduleName":"services.core"}}
```

产物位置：

- `<AOSP_ROOT>/.lsp-mcp-aosp-index/modules/<module>.json`

### 3.4 listPresets

用途：查看内置角色预设（当前包含 `audio`、`driver`、`system_server`）。

```json
{"name":"aosp","arguments":{"operation":"listPresets"}}
```

### 3.5 indexPreset

用途：按角色预设批量发现并索引模块，减少手工添加模块。

```json
{"name":"aosp","arguments":{"operation":"indexPreset","preset":"audio","maxModules":120}}
```

产物位置：

- `<AOSP_ROOT>/.lsp-mcp-aosp-index/presets/<preset>.json`
- `<AOSP_ROOT>/.lsp-mcp-aosp-index/modules/*.json`

### 3.6 queryPresetSymbol

用途：仅在预设索引结果中查符号。

```json
{"name":"aosp","arguments":{"operation":"queryPresetSymbol","preset":"audio","symbol":"AudioPolicyManager","limit":20}}
```

### 3.7 queryIndexedSymbol

用途：只在“已索引模块”内查符号，避免大范围扫描。

```json
{"name":"aosp","arguments":{"operation":"queryIndexedSymbol","moduleName":"services.core","symbol":"ActivityManagerService","limit":20}}
```

### 3.8 findPath / findSymbol / findClass / findModule

用途：受限范围检索（`repo` / `scope` / `moduleName`）。

示例（限制在单 repo）：

```json
{"name":"aosp","arguments":{"operation":"findClass","className":"ActivityManagerService","repo":"frameworks/base","limit":20}}
```

## 4. lsp 工具操作说明

适合在你已经定位到文件后做语义查询。

```json
{
  "name": "lsp",
  "arguments": {
    "operation": "goToDefinition",
    "filePath": "frameworks/base/services/core/java/com/android/server/am/ActivityManagerService.java",
    "line": 100,
    "character": 20
  }
}
```

注意：

- `line` / `character` 是 1-based
- C/C++ 语义质量强依赖 `compile_commands.json`

## 5. 推荐工作流（AOSP 开发者）

1. `aosp.detectRoot`
2. `aosp.listPresets` 选择一个角色预设（如 `audio`）
3. `aosp.indexPreset` 一键建立局部索引
4. `aosp.queryPresetSymbol` 定位定义点
5. `lsp.goToDefinition` / `lsp.findReferences` 深入分析
6. 需要扩大范围时，再补充 `indexModule`

## 6. 常见问题

1. `Module "... not found in module-info.json"`
- 先确认 AOSP 编译产物已生成 `module-info.json`
- 先跑 `aosp.resolveModule` 验证模块名

2. `ripgrep (rg) is required but not found in PATH`
- 安装 `rg` 并确保命令行可直接执行

3. C/C++ 跳转结果不准
- 检查 `clangd` 参数是否设置 `--compile-commands-dir`
- 检查该目录下 `compile_commands.json` 是否对应当前源码版本

4. 查询太慢
- 优先走 `indexPreset + queryPresetSymbol`
- 或 `indexModule + queryIndexedSymbol`
- 避免大 scope，优先指定 `moduleName` 或 `repo`
