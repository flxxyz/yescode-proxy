# 路由与协议翻译

代理处理四种路由，按 URL 分类后分别转发到不同上游。`/v1/chat/completions` 额外做双向协议翻译。

## 路由分类

`classifyRoute(urlPath)` 按 URL 前缀返回路由标识：

| URL 前缀 | 路由标识 | 上游协议 |
|---|---|---|
| `/v1beta/` | `gemini` | Gemini generateContent |
| `/v1/messages` | `anthropic` | Anthropic Messages |
| `/v1/chat/completions` | `openai-chat` | 统一入口（翻译后转发） |
| `/v1/` （其余） | `openai` | OpenAI Responses |
| 其它 | `unknown` | 返回 404 |

## 原生路由（passthrough）

`anthropic`、`openai`、`gemini` 三个路由是纯透传：只替换鉴权头和指纹（`buildUpstreamHeaders`），不翻译请求体或响应体。

Gemini 路由有一个路径改写：客户端用 `/v1beta/...`，上游需要 `<prefix>/gemini/v1beta/...`。

## 统一入口 /v1/chat/completions

路由标识为 `openai-chat`。由 `providerForModel(model)` 根据 `model` 名称前缀选择上游 provider：

| `model` 前缀 | provider | 上游端点 |
|---|---|---|
| `claude*` | `anthropic` | `/v1/messages` |
| `gemini*` | `gemini` | `/v1beta/models/{model}:generateContent` |
| `gpt*`、`o\d`、`chatgpt*`、`*codex*` | `openai` | `/v1/responses` |
| 其它（未匹配） | `openai` | `/v1/responses` |

### 请求翻译（Chat Completions -> 上游）

三个翻译函数将 OpenAI Chat Completions 格式转为各上游的原生格式：

- **`chatToResponses(reqBody)`** -> OpenAI Responses 格式。映射 `messages` 为 `input`（含 `input_text`、`output_text`、`function_call`、`function_call_output`），`system`/`developer` 角色合并为 `instructions`，`tools` 转为 Responses 格式。额外映射 `max_completion_tokens` -> `max_output_tokens`、`response_format` -> `text.format`、`reasoning_effort` -> `reasoning.effort`。
- **`chatToAnthropic(reqBody)`** -> Anthropic Messages 格式。`system`/`developer` 角色合并为顶层 `system` 字段，`messages` 转为交替的 `user`/`assistant` turns，相邻同角色消息合并（`pushBlocks`）。`tool_calls` 转为 `tool_use` 块，`tool` 角色转为 `tool_result` 块。`max_tokens` 必填，缺省 `DEFAULT_ANTHROPIC_MAX_TOKENS`（4096）。
- **`chatToGemini(reqBody)`** -> Gemini `contents` 格式。`system`/`developer` 合并为 `systemInstruction`，`assistant` 映射为 `model` 角色，`tool_calls` 转为 `functionCall`，`tool` 角色转为 `functionResponse`。`tools` 里的 JSON Schema 经 `stripGeminiSchema` 去除 Gemini 不支持的关键字（`additionalProperties`、`$schema`）。model 写入 URL path 而非 body。流式用 `streamGenerateContent?alt=sse`。

### 响应翻译（上游 -> Chat Completions）

非流式和流式各有独立翻译：

**非流式（JSON）**：
- `responsesJsonToChat(json, originalModel)` -- OpenAI Responses -> Chat Completions
- `anthropicJsonToChat(json, originalModel)` -- Anthropic Messages -> Chat Completions
- `geminiJsonToChat(json, originalModel)` -- Gemini generateContent -> Chat Completions

封装在 `makeJsonTransform` / `makeAnthropicJsonTransform` / `makeGeminiJsonTransform` 中，由 `forwardOnce` 在 `mode === 'json'` 分支调用。

**流式（SSE）**：
- `makeSSETransform` -- OpenAI Responses SSE -> Chat Completions chunk 流
- `makeAnthropicSSETransform` -- Anthropic Messages SSE -> Chat Completions chunk 流
- `makeGeminiSSETransform` -- Gemini SSE -> Chat Completions chunk 流

三者共用 `makeChatChunkEmitter` 生成统一的 `chat.completion.chunk` 信封，以 `data: [DONE]` 结尾。`makeSSEStreamTransform` 是 Anthropic/Gemini 共用的 SSE 行缓冲 -> JSON 事件分发框架。

### 翻译覆盖范围

- 文本、多轮对话、system/developer 消息、`tools`/`tool_calls`/`tool` 角色双向回传、流式输出。
- **不支持跨协议的 vision/图片**：OpenAI 路径保留 `image_url`，Claude/Gemini 路径丢弃图片块。
- Anthropic 要求非空 `system`：`isEmptySystem` 检测、`injectClaudeMetadata` 注入默认 preamble（`CLAUDE_CODE_SYSTEM_PREAMBLE`）。
- 非 2xx 的上游错误原样透传。

## Anthropic 指纹注入

`injectClaudeMetadata(body)` 对所有目标为 Anthropic 的请求（原生 `/v1/messages` 和翻译后的 `openai-chat`）注入：

- `metadata.user_id` -- Claude-CLI legacy 格式：`user_<deviceId>_account__session_<sessionId>`（`buildLegacyUserId`）。如果客户端已提供合法的 legacy 或 JSON session 格式则不覆盖（`needsUserIdRewrite` + `LEGACY_USER_ID_PATTERN`）。
- `system` 字段 -- 若为空（`isEmptySystem`），注入 `CLAUDE_CODE_SYSTEM_PREAMBLE`。

## Codex / Gemini UA 伪造

- **OpenAI 路由**：`User-Agent` 设为 `config.codexUserAgent`（默认 `codex_cli_rs/<版本>`），`originator` 设为 `config.codexOriginator`。上游按 UA 前缀 `codex` 路由到 Codex app-server。
- **Gemini 路由**：`User-Agent` 设为 `config.geminiUserAgent`（默认 Google GenAI SDK）。上游对竞品 SDK UA 返回 403。

## 重试与回落

详见 [../reference/endpoints-and-metrics.md](../reference/endpoints-and-metrics.md) 的路由表，以及 `forwardOnce` 的 `heldStatuses` 机制：

- **key fallback**：上游返回 `config.keyFallbackStatuses`（默认 401、403）时，切换到下一个凭证（`credentialsForRoute`）。
- **瞬时重试**：上游返回 `config.retryStatuses`（默认 429、503、529）时，按退避（200ms、600ms）重试主机，最后到回落上游试一次。
- **连接错误重试**：`shouldRetryUpstream` 检测 ECONNRESET、ETIMEDOUT 等，走同一退避调度。
- 退避调度：`PRIMARY_BACKOFFS_MS = [200, 600]`，`attempts` 数组为 primary(0ms) -> primary(200ms) -> primary(600ms) -> fallback(0ms)。
