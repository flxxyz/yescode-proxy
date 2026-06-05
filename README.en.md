English | [中文](README.md)

# yescode-proxy

HTTP reverse proxy fronting **co.yes.vg** (YesCode) for OpenClaw. Handles three routes — `/v1/messages` (Anthropic), `/v1/*` (OpenAI), `/v1beta/*` (Gemini) — strips client-supplied auth, injects the configured YesCode key, and (for Anthropic) rewrites the `metadata.user_id` + headers to pass YesCode's Claude-CLI fingerprint gate. Falls back from `co.yes.vg` to `co-cdn.yes.vg` on transient errors. When the upstream rejects the primary key with `401/403`, it retries the same request with that route's fallback key (see `YESCODE_API_KEY_*`). On transient upstream statuses (`429/503/529`) it retries the same request with backoff, then the fallback host, before surfacing the error (see `YESCODE_RETRY_STATUSES`).

**`/v1/chat/completions` is a universal endpoint.** The `model` name prefix selects the upstream backend; the proxy translates both the request and the response (JSON or SSE stream) in each direction, so an OpenAI Chat Completions client can drive Claude, Gemini, or OpenAI models without switching protocol:

| `model` prefix | Upstream | Upstream endpoint |
|---|---|---|
| `claude*` | Anthropic | `/v1/messages` |
| `gemini*` | Gemini | `/v1beta/models/{model}:generateContent` |
| else (`gpt*`, `o*`, `*codex*`, unknown) | OpenAI | `/v1/responses` |

Translation covers system messages, multi-turn text, streaming, and `tools`, `tool_calls`, `tool`-role round-trip in both directions. Credential selection and the upstream fingerprint (Claude-CLI `metadata.user_id`, codex `User-Agent`) follow the **resolved** backend, not the URL — a `claude*` model here gets the same fingerprint as the native `/v1/messages` route. **Vision/images are not supported cross-protocol**: the OpenAI path still accepts `image_url`, but the Claude/Gemini paths drop image parts. Anthropic requires `max_tokens`, so the Claude path defaults it to `4096` when the request sets neither `max_tokens` nor `max_completion_tokens`. The OpenAI path additionally maps `max_completion_tokens`, `response_format`, `reasoning_effort`. Non-2xx upstream errors pass through untouched.

The three native routes — `/v1/messages`, `/v1/responses`, `/v1beta/*` — stay plain passthrough (auth swap + fingerprint only, no body translation); call them directly to bypass translation entirely.

YesCode gates the codex models (`gpt-5.x`, `*-codex` on `/v1/responses`) behind a `User-Agent` prefix check: only a UA that looks like a codex client is routed to the real Codex app-server, otherwise the request falls through to an unconfigured path that returns `503 "Codex app-server responses fallback is not configured"`. So the proxy spoofs a codex `User-Agent` on the OpenAI route (see `YESCODE_CODEX_*`) to make `gpt-5.x` work — the same idea as the Claude-CLI fingerprint on the Anthropic route. `originator` is sent for fidelity but isn't part of the gate.

Listens on `127.0.0.1:18790` by default. Single-file ESM script, no runtime deps.

## Install

One-shot installer for macOS (launchd) and systemd-based Linux (Ubuntu, Debian, Fedora, Arch, openSUSE, RHEL, etc.):

```bash
git clone <this-repo> ~/yescode-proxy && cd ~/yescode-proxy
./install.sh
```

Optional env vars:

- `INSTALL_DIR=/path/to/dir` — install source elsewhere (default: script's own directory; the service points back at this path).
- `YESCODE_API_KEY=team-...` — auto-populates `.env` if currently empty.

```bash
YESCODE_API_KEY=team-xxxxxxxx ./install.sh
```

What it does:

1. Verifies Node.js ≥ 18 on PATH.
2. Copies `.env.example` → `.env` (chmod 600) if missing; fills in `YESCODE_API_KEY` from env when supplied.
3. Generates and installs the supervisor unit with absolute paths to your `node` binary and source dir:
   - Linux → `~/.config/systemd/user/yescode-proxy.service` + (if `logrotate` is installed) the logrotate timer/service.
   - macOS → `~/Library/LaunchAgents/com.openclaw.yescode-proxy.plist`.
4. Starts the service and polls `/health` until it responds (up to 10s).

The script is **idempotent** — re-running regenerates the unit and restarts. Re-run after moving the source dir or upgrading Node so paths get refreshed.

**Linux note:** to keep the service running after logout, run `sudo loginctl enable-linger $USER` once. The installer prints a warning if linger is off.

**macOS note:** log rotation is not configured by default. Install `logrotate` (`brew install logrotate`) or configure `newsyslog` if you need it.

## Uninstall

If install failed, or you just want to tear it down:

```bash
./uninstall.sh
```

By default keeps `.env` (your API key) and log files. To wipe them too:

- `--purge-logs` — also delete the current log + rotated archives
- `--purge-env` — also delete `.env` (**warning: contains `YESCODE_API_KEY`**)
- `--purge` — shorthand for `--purge-logs --purge-env`
- `-y` — skip the confirmation prompt

The script does not touch the source tree — `rm -rf` it yourself if you want.

## Deployment (systemd user service)

Installed as a **user-level** systemd service. User-linger is enabled, so it survives logout and reboot.

| Path | Role |
|---|---|
| `~/workspace/yescode-proxy/server.js` | source |
| `~/workspace/yescode-proxy/.env` | runtime config (see [Configuration](#configuration)) |
| `~/workspace/yescode-proxy/yescode-proxy.service` | upstream copy of the unit |
| `~/.config/systemd/user/yescode-proxy.service` | installed unit (`cp` from above, then `daemon-reload`) |
| `~/.local/state/yescode-proxy.log` | log output (file append + journal) |

Key unit fields:

- `WorkingDirectory=%h/workspace/yescode-proxy`
- `EnvironmentFile=%h/workspace/yescode-proxy/.env`
- `ExecStart=%h/.nvm/versions/node/v24.14.0/bin/node server.js`
- `ExecReload=/bin/kill -HUP $MAINPID` — drives the [hot-reload](#hot-reload).
- `Restart=on-failure`

## Hot-reload

Edits to `.env` apply **without restarting the process** (in-flight requests / SSE streams are preserved). Two triggers, both installed:

1. **SIGHUP** — `systemctl --user reload yescode-proxy` or `kill -HUP <pid>`.
2. **fs.watchFile** on `.env` — 1s poll, 200ms debounce. Save the file in any editor and the change applies in ~1s.

Reload reads `.env`, rebuilds the in-memory config object, logs a diff (`logBodies: true → false`, API keys masked). Per-request code paths read the live config object, so the next request sees the new value.

**Exceptions** — these require a full restart, reload only logs a warning and ignores the change:

- `PORT`, `BIND` — bound to the listen socket at boot.

**Stable across reloads** — when the env var is empty, these stay at their boot-time value to avoid shuffling the device fingerprint:

- `YESCODE_REMOTE_CONTAINER_ID`, `YESCODE_REMOTE_SESSION_ID` (random UUIDs at boot if unset)
- `deviceId` (sha256 of `YESCODE_DEVICE_SEED`, defaults to `"yescode-proxy-default"`)

Override the path that's watched with `YESCODE_ENV_FILE=<path>`.

## Log rotation

`StandardOutput=append:~/.local/state/yescode-proxy.log` writes forever; rotation is driven by a separate user-level systemd timer + logrotate (no root needed).

| File | Role |
|---|---|
| `~/.config/logrotate/yescode-proxy.conf` | logrotate ruleset |
| `~/.config/systemd/user/yescode-proxy-logrotate.service` | oneshot that runs `logrotate` |
| `~/.config/systemd/user/yescode-proxy-logrotate.timer` | `OnCalendar=hourly`, `Persistent=true` |
| `~/.local/state/yescode-proxy-logrotate.state` | logrotate's own state file |

**Policy**: daily OR ≥ 100M, whichever comes first; keep 7 compressed history files; **copytruncate** so the proxy's open append-fd stays valid (no service reload needed). Worst-case footprint ≈ 100M active + 7 × ~10M compressed ≈ **~170M**.

Rotated files are named `yescode-proxy.log-<YYYYMMDD>-<unix>.gz` (newest one stays uncompressed thanks to `delaycompress`).

## Configuration

Copy `.env.example` to `.env` and fill in. All keys are hot-reloadable except `PORT` and `BIND`.

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `18790` | Listen port (restart only). |
| `BIND` | `127.0.0.1` | Listen address (restart only). |
| `YESCODE_PRIMARY_URL` | `https://co.yes.vg/team` | Primary upstream as a full URL (scheme + host + optional path prefix). The scheme picks http/https, `host[:port]` addresses the socket, and the path becomes a prefix prepended to every route. Keep `/team` for team accounts, drop it for personal (e.g. `https://co.yes.vg`). |
| `YESCODE_FALLBACK_URL` | `https://co-cdn.yes.vg/team` | Fallback upstream when the primary returns a retriable network error; same URL format. |
| `YESCODE_API_KEY` | _empty_ | Unified **primary** key for all three routes. Force-overrides client-supplied auth. |
| `YESCODE_API_KEY_ANTHROPIC` | _empty_ | **Fallback** key for the Anthropic route, used when the primary key is rejected with a `YESCODE_KEY_FALLBACK_STATUSES` status. Reuses the same upstream URL (same `/team` prefix). |
| `YESCODE_API_KEY_OPENAI` | _empty_ | **Fallback** key for the OpenAI route, used when the primary key is rejected with a `YESCODE_KEY_FALLBACK_STATUSES` status. Reuses the same upstream URL (same `/team` prefix). |
| `YESCODE_API_KEY_GEMINI` | _empty_ | **Fallback** key for the Gemini route, used when the primary key is rejected with a `YESCODE_KEY_FALLBACK_STATUSES` status. Reuses the same upstream URL (same `/team` prefix). |
| `YESCODE_KEY_FALLBACK_STATUSES` | `401,403` | Upstream statuses (comma-separated) that trigger the fallback-key retry. Defaults to auth-revoked / not-allowed; excludes 5xx (upstream-side faults a different key won't fix). |
| `YESCODE_RETRY_STATUSES` | `429,503,529` | Upstream statuses (comma-separated) treated as **transient** and auto-retried. The proxy retries the same request on the primary's backoff schedule (200ms, 600ms), then the fallback host once, before surfacing the error. Mirrors the client-side auto-retry of the Anthropic/OpenAI SDKs so plain clients ride out a brief `no capacity available` (503) blip instead of hitting a hard failure. Unlike `YESCODE_KEY_FALLBACK_STATUSES` (which switches key), this just retries. |
| `YESCODE_TIMEOUT_MS` | `30000` | Upstream socket inactivity timeout (ms). Default 30s — triggers retry on hung connections. SSE streams stay open as long as data keeps flowing. |
| `YESCODE_CLAUDE_CLI_VERSION` | `2.1.75` | Used to build the spoofed `User-Agent`. |
| `YESCODE_CLAUDE_CLI_ENTRYPOINT` | `cli` | Same. |
| `YESCODE_CODEX_CLI_VERSION` | `0.137.0` | Version baked into the default codex `User-Agent`. |
| `YESCODE_CODEX_USER_AGENT` | `codex_cli_rs/<version>` | `User-Agent` sent upstream on the OpenAI route. **Must start with `codex`** or the upstream 503s codex models. |
| `YESCODE_CODEX_ORIGINATOR` | `codex_cli_rs` | `originator` header on the OpenAI route (fidelity only; not part of the upstream gate). |
| `YESCODE_GEMINI_USER_AGENT` | `google-genai-sdk/1.16.0 gl-node/v22.0.0` | `User-Agent` sent upstream on the Gemini route. YesCode's gemini upstream 403s on competing-SDK UAs (e.g. `OpenAI/JS`); any non-OpenAI value passes. |
| `YESCODE_ANTHROPIC_BETA` | `context-management-2025-06-27,interleaved-thinking-2025-05-14` | `anthropic-beta` header. |
| `YESCODE_FULL_FINGERPRINT` | _off_ | `1` = also send Stainless SDK telemetry + remote-container/session headers. |
| `YESCODE_STAINLESS_VERSION` | `0.74.0` | `X-Stainless-Package-Version`. |
| `YESCODE_DEVICE_SEED` | `yescode-proxy-default` | Hashed into the `metadata.user_id` device hash (stable across reloads). |
| `YESCODE_REMOTE_CONTAINER_ID` | _random per boot_ | Stable across reloads when unset; set explicitly to override. |
| `YESCODE_REMOTE_SESSION_ID` | _random per boot_ | Stable across reloads when unset; set explicitly to override. |
| `YESCODE_ENV_FILE` | `./.env` | Path to watch for reload. Useful if the working dir isn't where `.env` lives. |

## Common operations

```bash
# status / start / stop
systemctl --user status yescode-proxy
systemctl --user restart yescode-proxy           # only needed for PORT/BIND or server.js changes
systemctl --user stop yescode-proxy

# trigger reload (after editing .env — usually unnecessary, fs.watchFile picks it up)
systemctl --user reload yescode-proxy

# logs
tail -f ~/.local/state/yescode-proxy.log         # live, full
journalctl --user -u yescode-proxy -f            # same content, but with journald metadata
journalctl --user -u yescode-proxy | grep 'config reload'   # see hot-reload history
ls -lh ~/.local/state/yescode-proxy*             # rotated archives

# log rotation
systemctl --user list-timers yescode-proxy-logrotate           # next run
systemctl --user status yescode-proxy-logrotate.service        # last run
logrotate -d -s ~/.local/state/yescode-proxy-logrotate.state \
  ~/.config/logrotate/yescode-proxy.conf                       # dry-run
logrotate --force -s ~/.local/state/yescode-proxy-logrotate.state \
  ~/.config/logrotate/yescode-proxy.conf                       # force rotate now

# health
curl -s http://127.0.0.1:18790/health
```

## Re-deploying changes

| Changed | Action |
|---|---|
| `.env` | nothing — auto-reload (or `systemctl --user reload yescode-proxy`) |
| `server.js` | `systemctl --user restart yescode-proxy` |
| `yescode-proxy.service` | `cp` into `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user restart yescode-proxy` |
| logrotate config, timer, service | edit under `~/.config/...`, then `systemctl --user daemon-reload && systemctl --user restart yescode-proxy-logrotate.timer` |
