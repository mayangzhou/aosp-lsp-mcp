# 日常使用流程

## 流程 A：按领域递进搜索（推荐）

1. 执行 `aosp.init`（首次、切分支、重编译后）
2. 执行 `aosp.search`（日常统一入口）
3. 命中定位后，用 `lsp.goToDefinition` / `lsp.findReferences` 深挖

`aosp.search` 内部会自动：
- 选择/复用领域索引
- 先语义再文件检索
- 按需给出远端候选结果

## 流程 B：按角色快速开工（预设）

1. 选预设：`audio` / `driver` / `system_server`
2. 执行 `aosp.indexPreset`
3. 执行 `aosp.queryPresetSymbol` 快速定位
4. 对定位点使用 `lsp.goToDefinition` / `lsp.findReferences`

## 流程 C：按模块深入分析

1. `aosp.resolveModule`
2. `aosp.indexModule`
3. `aosp.queryIndexedSymbol`（带 `moduleName`）
4. LSP 语义跳转与引用分析

## 流程 D：局部范围兜底检索

仅在需要时使用：

- `aosp.findPath`（带 `repo` 或 `moduleName`）
- `aosp.findSymbol`（带 `repo` 或 `moduleName`）
- `aosp.findClass`（带 `repo` 或 `moduleName`）

禁止：

- 无限制全根目录文本检索
- 在已可预设命中的情况下反复手工扫描
