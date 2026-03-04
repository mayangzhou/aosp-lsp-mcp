# LSP MCP Server

一个可复用的 MCP Server，为代码 Agent 提供两类能力：

- 基于 Language Server Protocol (LSP) 的代码智能
- 面向 AOSP 大仓的快速定位与检索工具

## 项目目标

- 可迁移到不同 Agent 运行时
- 同时支持两种使用方式：
  - 独立 CLI（`stdio` MCP Server）
  - 可嵌入的库 API
- 配置优先：按项目改配置，不改代码
- 针对 AOSP 开箱即用：自动探测源码根目录 + 常见定位能力

## 安装

```bash
cd lsp-mcp-server
npm install
npm run build
```

## 作为独立 MCP Server 运行

```bash
node dist/index.js
```

环境变量：

- `WORKSPACE_ROOT`：工作区根目录（默认：当前目录）
- `LSP_MCP_CONFIG`：可选，配置文件绝对路径（默认：`${WORKSPACE_ROOT}/lsp-mcp-config.json`）

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "lsp": {
      "command": "node",
      "args": ["/path/to/lsp-mcp-server/dist/index.js"],
      "env": {
        "WORKSPACE_ROOT": "/path/to/your/project",
        "LSP_MCP_CONFIG": "/path/to/your/project/lsp-mcp-config.json"
      }
    }
  }
}
```

## 嵌入到其他 Agent 项目

发布或 link 该包后，可直接导入 API：

```ts
import { createLspMcpServer } from "lsp-mcp-server";

const { server, lspManager } = await createLspMcpServer({
  workspaceRoot: "/path/to/workspace",
  configPath: "/path/to/lsp-mcp-config.json",
  serverName: "my-agent-lsp",
  serverVersion: "0.1.0",
});

// 在这里接入你自己的 MCP transport：
// await server.connect(customTransport);
// ...
// await lspManager.shutdown();
```

## 配置文件

创建 `lsp-mcp-config.json`：

```json
{
  "includeDefaultServers": true,
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "initialization": {
        "preferences": {
          "importModuleSpecifierPreference": "relative"
        }
      }
    },
    "python": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py", ".pyi"]
    }
  }
}
```

说明：

- 如果你希望完全手动控制语言服务器列表，可把 `includeDefaultServers` 设为 `false`。
- 支持在单个服务器配置里使用 `env`，满足定制运行环境需求。

## LSP 工具操作

- `goToDefinition`（`filePath`, `line`, `character`）
- `findReferences`（`filePath`, `line`, `character`）
- `hover`（`filePath`, `line`, `character`）
- `documentSymbol`（`filePath`）
- `workspaceSymbol`（`query`，可选）
- `goToImplementation`（`filePath`, `line`, `character`）
- `prepareCallHierarchy`（`filePath`, `line`, `character`）
- `incomingCalls`（`filePath`, `line`, `character`）
- `outgoingCalls`（`filePath`, `line`, `character`）

## AOSP 工具操作

当前 MCP 工具名：`aosp`

完整实操文档：`docs/AOSP_MCP_使用指南.md`

- `detectRoot`：自动探测 AOSP 根目录（按 `.repo`、`build/soong`、`frameworks/base`、`system/core` 等锚点评分）
- `init`：一条命令完成环境检查 + domain 推断 + domain 索引初始化（推荐）
- `search`：日常检索入口（自动 domain + 递进检索，推荐）
- `listDomains`：列出领域配置（`audio` / `video` / `render`）
- `indexDomain`：按领域构建索引（`hotModules` 语义优先，`warmModules` 文件索引）
- `queryDomain`：领域递进查询（`semantic -> file -> optional remote`）
- `resolveModule`：优先基于 `module-info.json` 解析模块源码路径
- `indexModule`：为单个模块构建/更新局部索引分片（写入 `.lsp-mcp-aosp-index/modules/*.json`）
- `listPresets`：列出内置预设（`audio` / `driver` / `system_server`）
- `indexPreset`：按预设一键索引关联模块（写入 `.lsp-mcp-aosp-index/presets/*.json`）
- `queryIndexedSymbol`：只在已索引模块分片范围内查询符号
- `queryPresetSymbol`：只在某个预设索引结果内查询符号
- `findPath`：在受限范围内按路径关键字快速定位文件
- `findSymbol`：在受限范围内按符号文本快速搜索（返回文件、行列号、命中行）
- `findClass`：在受限范围内定位 Java/C++ 类或接口定义
- `findModule`：先查 `module-info.json`，未命中再回退到 `Android.bp`

限制策略（默认开启）：

- 不允许项目根目录全仓文本扫描
- 文本检索必须落在 `repo` 或 `scope` 或 `moduleName` 解析后的路径中
- 默认 `scope=frameworks`（不默认扫 `packages`）

推荐最简工作流：

1. 首次/切分支后执行一次 `init`
2. 后续统一调用 `search`

示例（MCP 调用参数）：

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "init",
    "focusPath": "frameworks/av"
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "search",
    "query": "AudioPolicyManager",
    "queryType": "auto",
    "allowRemote": false,
    "limit": 20
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "queryDomain",
    "domain": "audio",
    "query": "AudioPolicyManager",
    "queryType": "symbol",
    "mode": "auto",
    "allowRemote": false,
    "limit": 20
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "indexModule",
    "moduleName": "services.core"
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "queryIndexedSymbol",
    "moduleName": "services.core",
    "symbol": "ActivityManagerService",
    "limit": 20
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "resolveModule",
    "moduleName": "framework-minus-apex"
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "findModule",
    "moduleName": "framework-minus-apex",
    "repo": "frameworks/base",
    "limit": 20
  }
}
```

```json
{
  "name": "aosp",
  "arguments": {
    "operation": "findClass",
    "className": "ActivityManagerService",
    "moduleName": "services.core",
    "limit": 20
  }
}
```

## AOSP 开箱接入建议（ClaudeCode + stdio）

1. `WORKSPACE_ROOT` 直接指向 AOSP 源码根目录  
2. 配置 `LSP_MCP_CONFIG` 指向一份 AOSP 定制配置  
3. 先用 `aosp.detectRoot` 确认根目录评分，再用 `findPath/findClass/findModule` 快速落点

## 运行要求

- Node.js 18+
- 已安装对应语言的 LSP Server（例如 `typescript-language-server`、`pyright`、`rust-analyzer`、`gopls`）
- 建议安装 `ripgrep (rg)`，AOSP 工具依赖它做高性能检索

## 致谢

核心设计参考了 [OpenCode](https://github.com/anomalyco/opencode)。
