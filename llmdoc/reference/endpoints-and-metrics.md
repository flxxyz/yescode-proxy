# 端点、路由与指标参考

## 非业务端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health`、`/healthz` | GET | 返回 `{ "ok": true, "primary": "<host>", "fallback": "<host>" }`。 |
| `/` 或 `/index` | GET | 纯文本横幅，打印监听地址和上游信息。 |
| `/metrics` | GET | Prometheus 文本格式指标（`text/plain; version=0.0.4`）。不受虚拟 SK 鉴权保护。 |

以上端点在鉴权和路由分类之前处理，不计入 `requests_total`。

## 业务路由

| URL | 路由标识 | 上游端点 | 协议翻译 |
|---|---|---|---|
| `/v1/messages` | `anthropic` | `<prefix>/v1/messages` | 无（passthrough） |
| `/v1/responses`、`/v1/*`（除 messages 和 chat/completions 外） | `openai` | `<prefix>/v1/responses` 等 | 无（passthrough） |
| `/v1beta/*` | `gemini` | `<prefix>/gemini/v1beta/*` | 无（passthrough，路径加 `/gemini` 前缀） |
| `/v1/chat/completions` | `openai-chat` | 取决于 model 前缀 | 双向翻译 |

### /v1/chat/completions 的 model 前缀路由

| `model` 前缀 | 上游 provider | 上游端点 |
|---|---|---|
| `claude*` | `anthropic` | `<prefix>/v1/messages` |
| `gemini*` | `gemini` | `<prefix>/gemini/v1beta/models/{model}:generateContent` |
| `gpt*`、`o\d*`、`chatgpt*`、`*codex*` | `openai` | `<prefix>/v1/responses` |
| 其它（未匹配） | `openai` | `<prefix>/v1/responses` |

`model` 前缀匹配由 `providerForModel(model)` 实现。

## 上游指纹

各路由发往上游的请求头有不同的指纹策略：

| 路由 | `User-Agent` | 其它指纹头 |
|---|---|---|
| `anthropic` | `claude-cli/<version> (external, <entrypoint>)` | `anthropic-version: 2023-06-01`、`anthropic-beta`、`x-app: cli`、`metadata.user_id`（body 内）。`FULL_FINGERPRINT=1` 时追加 Stainless SDK 遥测头和 remote 头。 |
| `openai`、`openai-chat`（provider=openai） | `codex_cli_rs/<version>` | `originator: codex_cli_rs` |
| `gemini`、`openai-chat`（provider=gemini） | `google-genai-sdk/1.16.0 gl-node/v22.0.0` | -- |

所有路由都会删除客户端的 `x-stainless-*` 头，以免外部 SDK 指纹干扰上游校验。

## 重试调度

每个请求按以下顺序尝试（`attempts` 数组）：

| 序号 | 上游 | 延迟 |
|---|---|---|
| 1 | primary | 0ms |
| 2 | primary | 200ms |
| 3 | primary | 600ms |
| 4 | fallback | 0ms |

触发重试的条件：

- **连接错误**：ECONNRESET、ECONNREFUSED、ETIMEDOUT、ENOTFOUND、socket hang up、TLS 错误等（`shouldRetryUpstream` 函数检测）。
- **瞬时状态码**：`config.retryStatuses`（默认 429、503、529）。同一 key 退避重试。
- **key 失败状态码**：`config.keyFallbackStatuses`（默认 401、403）。切换到下一个凭证重新走完整调度。

凭证链由 `credentialsForRoute` 提供：team 主 key -> 路由对应的回退 key。

## Prometheus 指标

详见 [../architecture/metrics.md](../architecture/metrics.md)。指标清单摘要：

| 指标 | 类型 | labels |
|---|---|---|
| `yescode_requests_total` | counter | `vkey`、`route`、`status_class`（2xx/4xx/5xx） |
| `yescode_tokens_total` | counter | `vkey`、`route`、`direction`（input/output/cache_read/cache_write） |
| `yescode_bytes_total` | counter | `vkey`、`route` |
| `yescode_rejects_total` | counter | `reason`（missing/unknown/disabled/expired） |
| `yescode_fallbacks_total` | counter | `vkey`、`route` |
| `yescode_retries_total` | counter | `vkey`、`route` |
| `yescode_key_last_used_timestamp_seconds` | gauge | `vkey` |

`route` label 取值为 `anthropic`、`openai`、`openai-chat`、`gemini`、`unknown`。
