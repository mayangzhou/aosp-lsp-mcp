# 示例

## 1) 领域索引 + 递进查询（推荐）

```json
{"name":"aosp","arguments":{"operation":"init","focusPath":"frameworks/av","maxWarmModules":100}}
```

```json
{"name":"aosp","arguments":{"operation":"search","query":"AudioPolicyManager","queryType":"auto","allowRemote":false,"limit":20}}
```

## 2) 预设快速查询（高级）

```json
{"name":"aosp","arguments":{"operation":"indexPreset","preset":"audio","maxModules":120}}
```

```json
{"name":"aosp","arguments":{"operation":"queryPresetSymbol","preset":"audio","symbol":"AudioPolicyManager","limit":20}}
```

## 3) 单模块深挖

```json
{"name":"aosp","arguments":{"operation":"indexModule","moduleName":"services.core"}}
```

```json
{"name":"aosp","arguments":{"operation":"queryIndexedSymbol","moduleName":"services.core","symbol":"ActivityManagerService","limit":20}}
```

## 4) 语义跳转

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
