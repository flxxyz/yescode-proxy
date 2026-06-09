# 虚拟 SK 鉴权

代理在边缘维护一层虚拟 SK（virtual key）白名单鉴权。这是**纯附加层** -- 通过鉴权后，代理仍会用真实上游 key **强制覆盖**客户端发来的凭证（`buildUpstreamHeaders` 中删除 `authorization`/`x-api-key` 再注入配置的 key），虚拟 SK 永远不会到达上游。

## keys.json 格式

白名单存储在独立文件 `keys.json`（路径由 `KEYS_FILE_PATH` 决定，默认为工作目录下的 `keys.json`）。支持两种顶层格式：

```json
{ "keys": [ { "key": "sk-yc-...", ... }, ... ] }
```

或裸数组：

```json
[ { "key": "sk-yc-...", ... }, ... ]
```

每条记录的字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `key` | string | （必填） | 虚拟 SK 明文 |
| `label` | string | `maskMetricKey(key)` | 人类可读标签，仅日志用 |
| `enabled` | boolean | `true` | 设为 `false` 可停用而不删除 |
| `expires` | string (ISO 8601) | 无 | 过期时间，过期后该 key 被拒 |

解析由 `parseKeysFile(text)` 完成，结果存入 `Map<string, { label, enabled, expires }>`。

## fail-open 语义

`keys.json` 不存在、内容为空、或无有效条目时，`virtualKeys` 为空 Map。此时 `authorizeVirtualKey` 对**所有请求放行**（返回 `{ ok: true, vkey: null }`），保持向后兼容。启动日志打印 `virtual-key auth: disabled (fail-open)`。

一旦 `virtualKeys` 包含至少一条记录，鉴权即为强制模式。

## 鉴权流程

`authorizeVirtualKey(presented)` 的判定逻辑：

1. `virtualKeys.size === 0` -> 放行（fail-open），`vkey` 为 `null`。
2. 客户端未提供 key -> 拒绝，`reason: 'missing'`。
3. key 不在 Map 中 -> 拒绝，`reason: 'unknown'`。
4. `enabled === false` -> 拒绝，`reason: 'disabled'`。
5. `expires` 已过期 -> 拒绝，`reason: 'expired'`。
6. 以上均未命中 -> 放行，`vkey` 为 `maskMetricKey(key)`。

客户端 key 从请求头提取（`presentedClientKey`）：优先 `Authorization: Bearer <key>`，其次 `x-api-key`。

## 拦截位置

鉴权位于请求处理器中 `/health`、根路径、`/metrics` 之后，`readBody` 之前。未授权请求不缓冲 body。拒绝统一返回 401：

```json
{ "error": { "message": "invalid api key", "type": "authentication_error" } }
```

不区分「不存在」与「被禁用」，减少信息泄露。

**鉴权先于 unknown-route 判定**：未授权调用方对所有路径（包括不存在的路径）一律得 401，无法通过 401/404 差异探测已知路由。

## 凭证注入（与鉴权解耦）

`buildUpstreamHeaders` 负责：

- 删除客户端的 `authorization`、`x-api-key`。
- 注入 `credentialsForRoute(upstreamRoute)` 提供的真实上游 key。

凭证链：`config.apiKey`（team 主 key）-> 路由对应的回退 key（`config.apiKeyAnthropic` / `apiKeyOpenai` / `apiKeyGemini`）。主 key 被 `keyFallbackStatuses` 拒绝时自动切换到回退 key。

## 关键函数 / 变量

| 标识符 | 职责 |
|---|---|
| `virtualKeys` | 模块级 `Map`，key 明文 -> `{ label, enabled, expires }` |
| `parseKeysFile(text)` | JSON 文本 -> 新 Map |
| `loadKeysFile(path)` | 从磁盘读取并调用 `parseKeysFile`；文件不存在返回空 Map |
| `presentedClientKey(headers)` | 从请求头提取客户端 key |
| `authorizeVirtualKey(presented)` | 判定放行/拒绝，返回 `{ ok, vkey, reason }` |
| `credentialsForRoute(route)` | 返回该路由的有序凭证链 |
| `buildUpstreamHeaders(...)` | 构建上游请求头（含凭证注入和指纹改写） |
