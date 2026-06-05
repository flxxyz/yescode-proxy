[English](README.en.md) | 中文

# yescode-proxy

为 OpenClaw 反向代理 **co.yes.vg**（YesCode）的 HTTP 服务。处理三类路由 —— `/v1/messages`（Anthropic）、`/v1/*`（OpenAI）、`/v1beta/*`（Gemini）—— 剥除客户端自带的鉴权、注入配置好的 YesCode key；对 Anthropic 路由会改写 `metadata.user_id` 和请求头以通过 YesCode 的 Claude-CLI 指纹校验。遇到瞬时错误时从 `co.yes.vg` 自动回落到 `co-cdn.yes.vg`。当上游对主 key 返回 `401/403` 时，自动改用该路由的回退 key 重发同一请求（见 `YESCODE_API_KEY_*`）。上游返回 `429/503/529` 等瞬时状态码时，先按退避重试同一请求、再到回落上游试一次，仍失败才透传错误（见 `YESCODE_RETRY_STATUSES`）。

**`/v1/chat/completions` 是一个统一入口。** 由 `model` 名称前缀决定上游后端，代理对请求与响应（JSON 或 SSE 流）做双向协议翻译，于是客户端只用 OpenAI Chat Completions 协议就能驱动 Claude、Gemini、OpenAI 模型：

| `model` 前缀 | 上游 | 上游端点 |
|---|---|---|
| `claude*` | Anthropic | `/v1/messages` |
| `gemini*` | Gemini | `/v1beta/models/{model}:generateContent` |
| 其它（`gpt*`、`o*`、`*codex*`、未知）| OpenAI | `/v1/responses` |

翻译覆盖 system 消息、多轮文本、流式、以及 `tools`、`tool_calls`、`tool` 角色的双向回传。鉴权 key 的选择与上游指纹（Claude-CLI 的 `metadata.user_id`、codex 的 `User-Agent`）跟随**解析出的**后端、而非 URL —— 经此入口的 `claude*` 模型与原生 `/v1/messages` 路由用同一套指纹。**暂不支持跨协议的 vision/图片**：OpenAI 路径仍接受 `image_url`，但 Claude/Gemini 路径会丢弃图片块。Anthropic 要求 `max_tokens`，因此当请求既无 `max_tokens` 也无 `max_completion_tokens` 时，Claude 路径默认填 `4096`。OpenAI 路径额外映射 `max_completion_tokens`、`response_format`、`reasoning_effort`。非 2xx 的上游错误原样透传。

三个原生路由 —— `/v1/messages`、`/v1/responses`、`/v1beta/*` —— 保持纯透传（仅换鉴权 + 指纹，不翻译消息体）；想完全跳过翻译就直接调它们。

YesCode 把 codex 系模型（`gpt-5.x`、`*-codex`）藏在 `/v1/responses` 后，并对 `User-Agent` 做前缀校验：只有看起来像 codex 客户端的 UA 才会被路由到真正的 Codex app-server，否则落到未配置的兜底路径、返回 `503 "Codex app-server responses fallback is not configured"`。因此本代理在 OpenAI 路由上伪造 codex 的 `User-Agent`（见 `YESCODE_CODEX_*`），让 `gpt-5.x` 可用 —— 与 Anthropic 路由伪造 Claude-CLI 指纹同理。`originator` 仅为还原真实请求而发送，不参与校验。

默认监听 `127.0.0.1:18790`。单文件 ESM 脚本，无运行时依赖。

## 安装

macOS（launchd）和 systemd 系 Linux（Ubuntu、Debian、Fedora、Arch、openSUSE、RHEL 等）的一键安装脚本：

```bash
git clone <this-repo> ~/yescode-proxy && cd ~/yescode-proxy
./install.sh
```

可选环境变量：

- `INSTALL_DIR=/path/to/dir` —— 把源码装到别的目录（默认是脚本自身所在目录，service 会指向这个路径）。
- `YESCODE_API_KEY=team-...` —— 当 `.env` 当前为空时自动填入。

```bash
YESCODE_API_KEY=team-xxxxxxxx ./install.sh
```

脚本做的事：

1. 检查 PATH 中存在 Node.js ≥ 18。
2. 若没有 `.env`，从 `.env.example` 复制一份（chmod 600）；当提供了环境变量时填入 `YESCODE_API_KEY`。
3. 生成并安装 supervisor unit，使用 `node` 二进制和源码目录的绝对路径：
   - Linux → `~/.config/systemd/user/yescode-proxy.service` +（若装了 `logrotate`）logrotate timer/service。
   - macOS → `~/Library/LaunchAgents/com.openclaw.yescode-proxy.plist`。
4. 启动服务并轮询 `/health` 直到响应（最多 10 秒）。

脚本是 **幂等** 的 —— 重复执行会重新生成 unit 并重启。移动源码目录或升级 Node 后再跑一次，路径就刷新了。

**Linux 提示**：登出后想让服务继续运行，执行一次 `sudo loginctl enable-linger $USER`。若未开启 linger，安装器会输出警告。

**macOS 提示**：默认不配置日志轮转。需要的话装 `logrotate`（`brew install logrotate`）或配置 `newsyslog`。

## 卸载

安装出问题或不再需要时：

```bash
./uninstall.sh
```

默认保留 `.env`（含 API key）和日志文件。要一并删除：

- `--purge-logs` —— 同时删除当前日志和已轮转归档
- `--purge-env` —— 同时删除 `.env`（**注意：含 `YESCODE_API_KEY`**）
- `--purge` —— 等同 `--purge-logs --purge-env`
- `-y` —— 跳过确认提示

脚本不会动源码目录，需要时自行 `rm -rf`。

## 部署（systemd 用户级服务）

以 **用户级** systemd service 形态运行。已开启 user-linger，可在登出 / 重启后存活。

| 路径 | 用途 |
|---|---|
| `~/workspace/yescode-proxy/server.js` | 源码 |
| `~/workspace/yescode-proxy/.env` | 运行时配置（见 [配置](#配置)） |
| `~/workspace/yescode-proxy/yescode-proxy.service` | unit 的上游副本 |
| `~/.config/systemd/user/yescode-proxy.service` | 已安装的 unit（从上面 `cp` 而来，然后 `daemon-reload`） |
| `~/.local/state/yescode-proxy.log` | 日志输出（追加写文件 + journal） |

关键 unit 字段：

- `WorkingDirectory=%h/workspace/yescode-proxy`
- `EnvironmentFile=%h/workspace/yescode-proxy/.env`
- `ExecStart=%h/.nvm/versions/node/v24.14.0/bin/node server.js`
- `ExecReload=/bin/kill -HUP $MAINPID` —— 驱动 [热重载](#热重载)。
- `Restart=on-failure`

## 热重载

修改 `.env` 后可 **无需重启进程** 即刻生效（正在处理的请求 / SSE 流不受影响）。两种触发方式，都已经装好：

1. **SIGHUP** —— `systemctl --user reload yescode-proxy` 或 `kill -HUP <pid>`。
2. **fs.watchFile** 监视 `.env` —— 1 秒轮询，200 毫秒去抖。在任意编辑器里保存文件，约 1 秒后生效。

热重载会读取 `.env`、重建内存中的配置对象、打印 diff（如 `logBodies: true → false`，API key 被遮蔽）。请求处理路径读的是实时配置对象，下一个请求即可看到新值。

**例外** —— 这些字段需要完整重启，热重载只会打印警告并忽略改动：

- `PORT`、`BIND` —— 启动时绑定到监听 socket。

**跨重载保持稳定** —— 当对应的环境变量为空时，这些字段保持启动时的值，避免设备指纹变动：

- `YESCODE_REMOTE_CONTAINER_ID`、`YESCODE_REMOTE_SESSION_ID`（未设置时启动时随机生成 UUID）
- `deviceId`（`YESCODE_DEVICE_SEED` 的 sha256，默认 `"yescode-proxy-default"`）

通过 `YESCODE_ENV_FILE=<path>` 可以覆盖被监视的路径。

## 日志轮转

`StandardOutput=append:~/.local/state/yescode-proxy.log` 永久追加；轮转由独立的用户级 systemd timer + logrotate 完成（不需要 root）。

| 文件 | 用途 |
|---|---|
| `~/.config/logrotate/yescode-proxy.conf` | logrotate 规则集 |
| `~/.config/systemd/user/yescode-proxy-logrotate.service` | 跑 `logrotate` 的 oneshot |
| `~/.config/systemd/user/yescode-proxy-logrotate.timer` | `OnCalendar=hourly`、`Persistent=true` |
| `~/.local/state/yescode-proxy-logrotate.state` | logrotate 自己的状态文件 |

**策略**：按天 或 ≥ 100M 二者先到者轮转；保留 7 份压缩历史；**copytruncate** 模式让 proxy 已打开的 append-fd 继续有效（无需 reload 服务）。最坏占用 ≈ 100M 当前 + 7 × ~10M 压缩 ≈ **~170M**。

轮转后的文件命名为 `yescode-proxy.log-<YYYYMMDD>-<unix>.gz`（最近一份因 `delaycompress` 暂不压缩）。

## 配置

把 `.env.example` 复制为 `.env` 后填写。除了 `PORT`、`BIND`，所有 key 都支持热重载。

| Key | 默认值 | 用途 |
|---|---|---|
| `PORT` | `18790` | 监听端口（仅重启生效）。 |
| `BIND` | `127.0.0.1` | 监听地址（仅重启生效）。 |
| `YESCODE_PRIMARY_URL` | `https://co.yes.vg/team` | 主上游完整 URL（协议 + 主机 + 可选路径前缀）。协议决定 http/https，`host[:port]` 定位套接字，路径作为前缀拼到每个路由前。team 账号带 `/team`，个人账号去掉（如 `https://co.yes.vg`）。 |
| `YESCODE_FALLBACK_URL` | `https://co-cdn.yes.vg/team` | 主上游返回可重试网络错误时的回落上游，URL 格式同上。 |
| `YESCODE_API_KEY` | _空_ | 三个路由共用的**主** key，强制覆盖客户端自带鉴权。 |
| `YESCODE_API_KEY_ANTHROPIC` | _空_ | Anthropic 路由的**回退** key，主 key 被 `YESCODE_KEY_FALLBACK_STATUSES` 状态码拒绝时启用，沿用相同的上游 URL（同 `/team` 前缀）。 |
| `YESCODE_API_KEY_OPENAI` | _空_ | OpenAI 路由的**回退** key，主 key 被 `YESCODE_KEY_FALLBACK_STATUSES` 状态码拒绝时启用，沿用相同的上游 URL（同 `/team` 前缀）。 |
| `YESCODE_API_KEY_GEMINI` | _空_ | Gemini 路由的**回退** key，主 key 被 `YESCODE_KEY_FALLBACK_STATUSES` 状态码拒绝时启用，沿用相同的上游 URL（同 `/team` 前缀）。 |
| `YESCODE_KEY_FALLBACK_STATUSES` | `401,403` | 触发回退 key 重试的上游状态码（逗号分隔）。默认认证失败/无权限；不含 5xx（上游服务端故障，换 key 也救不了）。 |
| `YESCODE_RETRY_STATUSES` | `429,503,529` | 视为**瞬时**、自动重试的上游状态码（逗号分隔）。代理对同一请求按退避（200ms、600ms）在主机重试、再到回落上游试一次，仍失败才把错误透传。模拟 Anthropic/OpenAI SDK 客户端侧的自动重试，让普通客户端能扛过短暂的 `no capacity available`（503）抖动，而不是直接吃到硬失败。与 `YESCODE_KEY_FALLBACK_STATUSES` 不同：那个换 key，这个只重试。 |
| `YESCODE_TIMEOUT_MS` | `30000` | 上游 socket 无活动超时（毫秒）。默认 30 秒 —— 连接挂起时触发重试。SSE 流只要持续有数据就不会超时。 |
| `YESCODE_CLAUDE_CLI_VERSION` | `2.1.75` | 用于伪造 `User-Agent`。 |
| `YESCODE_CLAUDE_CLI_ENTRYPOINT` | `cli` | 同上。 |
| `YESCODE_CODEX_CLI_VERSION` | `0.137.0` | 拼进 codex `User-Agent` 默认值的版本号。 |
| `YESCODE_CODEX_USER_AGENT` | `codex_cli_rs/<版本>` | OpenAI 路由发往上游的 `User-Agent`。**必须以 `codex` 开头**，否则上游对 codex 模型返回 503。 |
| `YESCODE_CODEX_ORIGINATOR` | `codex_cli_rs` | OpenAI 路由的 `originator` 请求头（仅为还原真实请求，不参与上游校验）。 |
| `YESCODE_GEMINI_USER_AGENT` | `google-genai-sdk/1.16.0 gl-node/v22.0.0` | Gemini 路由发往上游的 `User-Agent`。YesCode 的 gemini 上游会对竞品 SDK 的 UA（如 `OpenAI/JS`）返回 403；任何非 OpenAI 值均可通过。 |
| `YESCODE_ANTHROPIC_BETA` | `context-management-2025-06-27,interleaved-thinking-2025-05-14` | `anthropic-beta` 请求头。 |
| `YESCODE_FULL_FINGERPRINT` | _关_ | `1` = 同时发送 Stainless SDK 遥测 + remote-container/session 请求头。 |
| `YESCODE_STAINLESS_VERSION` | `0.74.0` | `X-Stainless-Package-Version`。 |
| `YESCODE_DEVICE_SEED` | `yescode-proxy-default` | 哈希后写入 `metadata.user_id` 的设备 hash（跨重载稳定）。 |
| `YESCODE_REMOTE_CONTAINER_ID` | _每次启动随机_ | 未设置时跨重载保持启动时的值；显式设置可覆盖。 |
| `YESCODE_REMOTE_SESSION_ID` | _每次启动随机_ | 未设置时跨重载保持启动时的值；显式设置可覆盖。 |
| `YESCODE_ENV_FILE` | `./.env` | 被监视的路径。若工作目录不是 `.env` 所在位置时有用。 |

## 常用操作

```bash
# 状态 / 启动 / 停止
systemctl --user status yescode-proxy
systemctl --user restart yescode-proxy           # 只在改了 PORT/BIND 或 server.js 后才需要
systemctl --user stop yescode-proxy

# 触发 reload（改完 .env 后 —— 一般不必，fs.watchFile 会自动捕获）
systemctl --user reload yescode-proxy

# 日志
tail -f ~/.local/state/yescode-proxy.log         # 实时全量
journalctl --user -u yescode-proxy -f            # 内容相同，附带 journald 元数据
journalctl --user -u yescode-proxy | grep 'config reload'   # 查看热重载历史
ls -lh ~/.local/state/yescode-proxy*             # 已轮转的归档

# 日志轮转
systemctl --user list-timers yescode-proxy-logrotate           # 下次执行时间
systemctl --user status yescode-proxy-logrotate.service        # 上次执行
logrotate -d -s ~/.local/state/yescode-proxy-logrotate.state \
  ~/.config/logrotate/yescode-proxy.conf                       # dry-run
logrotate --force -s ~/.local/state/yescode-proxy-logrotate.state \
  ~/.config/logrotate/yescode-proxy.conf                       # 立即强制轮转

# 健康检查
curl -s http://127.0.0.1:18790/health
```

## 重新部署变更

| 改了什么 | 操作 |
|---|---|
| `.env` | 无需操作 —— 自动 reload（或 `systemctl --user reload yescode-proxy`） |
| `server.js` | `systemctl --user restart yescode-proxy` |
| `yescode-proxy.service` | `cp` 到 `~/.config/systemd/user/`，然后 `systemctl --user daemon-reload && systemctl --user restart yescode-proxy` |
| logrotate 配置、timer、service | 在 `~/.config/...` 下改完后执行 `systemctl --user daemon-reload && systemctl --user restart yescode-proxy-logrotate.timer` |
