# 预设目录

## audio

- 适用角色：音频/媒体开发
- 核心仓库：`frameworks/av`、`system/media`、`hardware/interfaces`
- 常见查询词：`AudioPolicyManager`、`AudioFlinger`、`audioserver`

## driver

- 适用角色：底层驱动/HAL
- 核心仓库：`hardware/interfaces`、`hardware/libhardware`、`system/core`
- 常见查询词：`hwservicemanager`、`hal`、`aidl_interface`

## system_server

- 适用角色：Framework 服务开发
- 核心仓库：`frameworks/base/services`、`frameworks/base/core`
- 常见查询词：`ActivityManagerService`、`WindowManagerService`

## 选择策略

1. 用户明确说“音频/驱动/系统服务”：直接选对应预设
2. 用户只给模块名：先 `resolveModule` 再决定是否补 `indexModule`
3. 用户需要跨域分析：先 `indexPreset`，不够再补单模块
