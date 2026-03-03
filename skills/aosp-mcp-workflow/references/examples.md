# 示例

## 1) 一键音频索引并检索

```json
{"name":"aosp","arguments":{"operation":"indexPreset","preset":"audio","maxModules":120}}
```

```json
{"name":"aosp","arguments":{"operation":"queryPresetSymbol","preset":"audio","symbol":"AudioPolicyManager","limit":20}}
```

## 2) 单模块深挖

```json
{"name":"aosp","arguments":{"operation":"indexModule","moduleName":"services.core"}}
```

```json
{"name":"aosp","arguments":{"operation":"queryIndexedSymbol","moduleName":"services.core","symbol":"ActivityManagerService","limit":20}}
```

## 3) 语义跳转

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
