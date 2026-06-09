# Prometheus 指标

代理在 `GET /metrics` 暴露 Prometheus 文本格式的内存计数器，零依赖。计数器重启清零、不持久化。

## 端点

`GET /metrics` -- 返回 `text/plain; version=0.0.4; charset=utf-8`。位于请求处理器中 `/health` 和根路径之后、鉴权之前，不受虚拟 SK 白名单保护。安全性依赖 `BIND`（默认 `127.0.0.1` 仅本机可访问）。

渲染由 `renderMetrics()` 完成。

## 指标清单

| 指标 | 类型 | labels | 说明 |
|---|---|---|---|
| `yescode_requests_total` | counter | `vkey`、`route`、`status_class` | 通过鉴权的请求终态计数 |
| `yescode_tokens_total` | counter | `vkey`、`route`、`direction` | token 数（direction: `input`/`output`/`cache_read`/`cache_write`） |
| `yescode_bytes_total` | counter | `vkey`、`route` | 上游响应字节数 |
| `yescode_rejects_total` | counter | `reason` | 鉴权拒绝计数（**不带 `vkey`**） |
| `yescode_fallbacks_total` | counter | `vkey`、`route` | key 失败后换凭证的次数 |
| `yescode_retries_total` | counter | `vkey`、`route` | 瞬时错误重试次数 |
| `yescode_key_last_used_timestamp_seconds` | gauge | `vkey` | 虚拟 key 最后使用时间（Unix 秒） |

## label 值约定

- **`vkey`** -- 始终为 `maskMetricKey(key)` 的输出或 `'(none)'`（fail-open 时）。只取自白名单，不取自客户端提供的值，保证取值有界。
- **`route`** -- 固定枚举：`anthropic`、`openai`、`openai-chat`、`gemini`、`unknown`。
- **`status_class`** -- `2xx`、`4xx`、`5xx`（`statusClass` 函数）。不用原始状态码，收敛基数。
- **`direction`** -- `input`、`output`、`cache_read`、`cache_write`。
- **`reason`** -- `missing`、`unknown`、`disabled`、`expired`。

## 基数保护

`rejects_total` 故意**不带 `vkey`** label。被拒请求的 key 由调用方任意构造，进 label 会导致基数爆炸。只按固定的 `reason` 分类。

`requests_total` 与 `rejects_total` 不相交：前者是通过鉴权的请求，后者是被挡住的请求。总流量 = 两者之和。

## maskMetricKey 脱敏

`maskMetricKey(sk)` 规则：

- 保留 `sk-yc-` 前缀（公开常量），主体保留前 4 位 + 固定 `xxxx` + 后 4 位。
- 示例：`sk-yc-alice-9f3k2m` -> `sk-yc-alicxxxx3k2m`。
- 主体不足 8 位时整段替换为 `xxxx`（避免短串暴露全貌）。
- 空值返回 `'(none)'`。

与 `maskAuthValue`（前 8 后 6 加省略号）不同，`maskMetricKey` 专用于指标 label 和日志中的虚拟 SK。

## reqCtx + close 钩子

请求处理器在鉴权之后注册 `res.on('close', ...)`，hook 内用 `setImmediate` 延迟调用 `recordOutcome(reqCtx, res)`。

延迟原因：`res.end()` 在 `forwardOnce` 内部触发的 `close` 事件经 nextTick 派发，先于 `await forwardOnce` 的 promise 微任务恢复。如果 close 钩子同步执行 `recordOutcome`，`reqCtx.usage` 和 `reqCtx.bytes` 尚未赋值，会漏记 token 和字节。`setImmediate` 在 check 阶段运行，此时 `reqCtx` 已完全填充。

`recorded` 标志防止重复计数。`reqCtx.skip = true` 用于鉴权拒绝的请求（已计入 `rejects_total`，不再计入 `requests_total`）。

## usage 抽取

token 用量从上游响应中提取：

- `usageFromAnthropic(u)` -- `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`。
- `usageFromOpenAI(u)` -- `prompt_tokens`/`input_tokens`、`completion_tokens`/`output_tokens`。
- `usageFromGemini(u)` -- `promptTokenCount`、`candidatesTokenCount`。

所有函数返回统一结构 `{ in, out, cache_read, cache_write }`（`usageNums`）。`formatUsageParts` 将同一结构格式化为日志字符串。

JSON 响应用 `extractJSONUsage`，SSE 响应用 `extractSSEUsage`。Anthropic SSE 需要聚合 `message_start`（input + cache）和 `message_delta`（output）两个事件。翻译 transform 也可通过 `getCapturedUsage()` 提供 usage，作为兜底。

## 数据结构

```js
const metrics = {
  requests:  new Map(),  // vkey + route + status_class -> count
  tokens:    new Map(),  // vkey + route + direction -> count
  bytes:     new Map(),  // vkey + route -> count
  rejects:   new Map(),  // reason -> count
  fallbacks: new Map(),  // vkey + route -> count
  retries:   new Map(),  // vkey + route -> count
  lastUsed:  new Map(),  // vkey -> unix seconds
};
```

复合 key 用 `\x1f`（`SEP`）连接。`inc(map, key, by)` 执行自增。Node 单线程，无需加锁。

## 关键函数

| 标识符 | 职责 |
|---|---|
| `inc(map, key, by)` | 对 Map 中的 key 做 += by |
| `statusClass(code)` | HTTP 状态码 -> `2xx`/`4xx`/`5xx` |
| `recordOutcome(ctx, res)` | close 钩子的核心，按 `res.statusCode` 归类落账 |
| `renderMetrics()` | 遍历所有 Map 输出 Prometheus 文本 |
| `escLabel(v)` | Prometheus label 值转义（反斜杠、换行、双引号） |
| `maskMetricKey(sk)` | 虚拟 SK -> 脱敏字符串 |
