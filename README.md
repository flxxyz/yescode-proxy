# yescode-proxy

HTTP reverse proxy fronting **co.yes.vg** (YesCode) for OpenClaw. Handles three routes — `/v1/messages` (Anthropic), `/v1/*` (OpenAI), `/gemini/*` (Google) — strips client-supplied auth, injects the configured YesCode key, and (for Anthropic) rewrites the `metadata.user_id` + headers to pass YesCode's Claude-CLI fingerprint gate. Falls back from `co.yes.vg` to `co-cdn.yes.vg` on transient errors.

Listens on `127.0.0.1:18790` by default. Single-file ESM script, no runtime deps.

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

Copy `.env.example` to `.env` and fill in. All keys are hot-reloadable except `PORT` / `BIND`.

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `18790` | Listen port (restart only). |
| `BIND` | `127.0.0.1` | Listen address (restart only). |
| `YESCODE_PRIMARY` | `co.yes.vg` | Primary upstream. |
| `YESCODE_FALLBACK` | `co-cdn.yes.vg` | Fallback when primary returns a retriable network error. |
| `YESCODE_PATH_PREFIX` | _empty_ | Prefix prepended to every upstream URL. `/team` for team accounts, blank for personal. |
| `YESCODE_API_KEY` | _empty_ | Unified key for all three routes. Force-overrides client-supplied auth. |
| `YESCODE_API_KEY_ANTHROPIC` / `_OPENAI` / `_GEMINI` | _empty_ | Per-route overrides; fall back to `YESCODE_API_KEY`. |
| `YESCODE_TIMEOUT_MS` | `3600000` | Upstream request timeout (ms). Default 1h to fit long agent runs. |
| `YESCODE_CLAUDE_CLI_VERSION` | `2.1.75` | Used to build the spoofed `User-Agent`. |
| `YESCODE_CLAUDE_CLI_ENTRYPOINT` | `cli` | Same. |
| `YESCODE_ANTHROPIC_BETA` | `context-management-2025-06-27,interleaved-thinking-2025-05-14` | `anthropic-beta` header. |
| `YESCODE_FULL_FINGERPRINT` | _off_ | `1` = also send Stainless SDK telemetry + remote-container/session headers. |
| `YESCODE_STAINLESS_VERSION` | `0.74.0` | `X-Stainless-Package-Version`. |
| `YESCODE_DEVICE_SEED` | `yescode-proxy-default` | Hashed into the `metadata.user_id` device hash (stable across reloads). |
| `YESCODE_REMOTE_CONTAINER_ID` / `_SESSION_ID` | _random per boot_ | Stable across reloads when unset; set explicitly to override. |
| `YESCODE_ENV_FILE` | `./. env` | Path to watch for reload. Useful if the working dir isn't where `.env` lives. |

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
| logrotate config / timer / service | edit under `~/.config/...`, then `systemctl --user daemon-reload && systemctl --user restart yescode-proxy-logrotate.timer` |
