# 环境变量参考

所有配置通过 `.env` 文件设置。除 `PORT` 和 `BIND` 外均支持[热重载](../architecture/hot-reload.md)。

## 网络与监听

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `18790` | 监听端口。仅重启生效。 |
| `BIND` | `127.0.0.1` | 监听地址。仅重启生效。 |
| `YESCODE_PRIMARY_URL` | `https://co.yes.vg/team` | 主上游完整 URL（协议 + 主机 + 可选路径前缀）。协议决定 http/https，`host[:port]` 定位套接字，路径作为前缀拼到每个路由前。team 账号带 `/team`，个人账号去掉。 |
| `YESCODE_FALLBACK_URL` | `https://co-cdn.yes.vg/team` | 回落上游，格式同上。主上游返回可重试网络错误或瞬时状态码时启用。 |
| `YESCODE_TIMEOUT_MS` | `30000` | 上游 socket 无活动超时（毫秒）。SSE 流只要持续有数据就不会超时。 |

## 凭证

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_API_KEY` | 空 | 三个路由共用的主 key。强制覆盖客户端自带鉴权。 |
| `YESCODE_API_KEY_ANTHROPIC` | 空 | Anthropic 路由的回退 key。主 key 被 `YESCODE_KEY_FALLBACK_STATUSES` 拒绝时启用。 |
| `YESCODE_API_KEY_OPENAI` | 空 | OpenAI 路由的回退 key。 |
| `YESCODE_API_KEY_GEMINI` | 空 | Gemini 路由的回退 key。 |

## 重试策略

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_KEY_FALLBACK_STATUSES` | `401,403` | 触发换 key 重试的上游状态码（逗号分隔）。 |
| `YESCODE_RETRY_STATUSES` | `429,503,529` | 视为瞬时、自动重试的上游状态码（逗号分隔）。退避 200ms、600ms 重试主机，再到回落上游一次。与 `KEY_FALLBACK_STATUSES` 不同：后者换 key，前者只重试。 |

## Anthropic 指纹

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_CLAUDE_CLI_VERSION` | `2.1.75` | 拼入伪造的 `User-Agent`。 |
| `YESCODE_CLAUDE_CLI_ENTRYPOINT` | `cli` | 同上。最终 UA 格式：`claude-cli/<版本> (external, <entrypoint>)`。 |
| `YESCODE_ANTHROPIC_BETA` | `context-management-2025-06-27,interleaved-thinking-2025-05-14` | `anthropic-beta` 请求头。 |
| `YESCODE_DEVICE_SEED` | `yescode-proxy-default` | SHA-256 后写入 `metadata.user_id` 的设备 hash。跨重载稳定。 |
| `YESCODE_FULL_FINGERPRINT` | 关（非 `1`） | `1` 时同时发送 Stainless SDK 遥测头和 remote-container/session 头。 |
| `YESCODE_STAINLESS_VERSION` | `0.74.0` | `X-Stainless-Package-Version` 头的值。 |
| `YESCODE_REMOTE_CONTAINER_ID` | 每次启动随机 UUID | 未设置时跨重载保持启动时的值。 |
| `YESCODE_REMOTE_SESSION_ID` | 每次启动随机 UUID | 同上。 |

## OpenAI / Codex 指纹

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_CODEX_CLI_VERSION` | `0.137.0` | 拼入 codex `User-Agent` 默认值的版本号。 |
| `YESCODE_CODEX_USER_AGENT` | `codex_cli_rs/<版本>` | OpenAI 路由发往上游的 `User-Agent`。**必须以 `codex` 开头**，否则上游对 codex 模型返回 503。 |
| `YESCODE_CODEX_ORIGINATOR` | `codex_cli_rs` | OpenAI 路由的 `originator` 请求头。仅为还原真实请求，不参与上游校验。 |

## Gemini 指纹

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_GEMINI_USER_AGENT` | `google-genai-sdk/1.16.0 gl-node/v22.0.0` | Gemini 路由发往上游的 `User-Agent`。上游对竞品 SDK UA（如 `OpenAI/JS`）返回 403；任何非 OpenAI 值均可通过。 |

## 调试

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_DEBUG_BODIES` | 关（非 `1`/`true`/`yes`/`on`） | 开启后对每个请求打印遮蔽后的请求头、客户端 body 和上游响应 body。body 截断阈值 `DEBUG_BODY_LIMIT = 16384` 字符。 |

## 文件路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `YESCODE_ENV_FILE` | `<cwd>/.env` | 被监视的 `.env` 路径。若工作目录不是 `.env` 所在位置时有用。 |
| `YESCODE_KEYS_FILE` | `<cwd>/keys.json` | 虚拟 SK 白名单路径。 |
