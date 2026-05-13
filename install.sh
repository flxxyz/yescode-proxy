#!/usr/bin/env bash
set -euo pipefail

# One-shot installer for yescode-proxy.
#   Linux: systemd user service (Ubuntu/Debian/Fedora/Arch/openSUSE/RHEL ...)
#   macOS: launchd LaunchAgent
#
# Run from the repo root:  ./install.sh
# Optional env vars:
#   INSTALL_DIR=/path/to/dir    where source lives (default: script dir)
#   YESCODE_API_KEY=team-...    auto-populate .env if currently empty

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
SERVICE="yescode-proxy"

log()  { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

command -v node >/dev/null 2>&1 \
  || die "Node.js not found. Install Node 18+ first (https://nodejs.org or your package manager)."
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "need Node 18+, found $(node -v)"

for f in server.js .env.example; do
  [ -f "$INSTALL_DIR/$f" ] || die "$INSTALL_DIR/$f missing — run from repo root or set INSTALL_DIR."
done

log "platform=$PLATFORM  node=$NODE_BIN ($(node -v))  install_dir=$INSTALL_DIR"

ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "created .env from template"
fi

if [ -n "${YESCODE_API_KEY:-}" ] && grep -q '^YESCODE_API_KEY=' "$ENV_FILE"; then
  if [ "$PLATFORM" = macos ]; then
    sed -i '' "s|^YESCODE_API_KEY=.*|YESCODE_API_KEY=$YESCODE_API_KEY|" "$ENV_FILE"
  else
    sed -i "s|^YESCODE_API_KEY=.*|YESCODE_API_KEY=$YESCODE_API_KEY|" "$ENV_FILE"
  fi
  log "wrote YESCODE_API_KEY into .env"
fi

if ! grep -q '^YESCODE_API_KEY=.\+' "$ENV_FILE"; then
  warn "YESCODE_API_KEY is empty — clients must supply Authorization or set it in $ENV_FILE before real traffic."
fi

PORT="$(grep '^PORT=' "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^PORT=//')"
PORT="${PORT:-18790}"

if [ "$PLATFORM" = linux ]; then
  command -v systemctl >/dev/null 2>&1 \
    || die "systemctl missing; this script targets systemd distros. Run manually: $NODE_BIN $INSTALL_DIR/server.js"
  systemctl --user list-units >/dev/null 2>&1 \
    || die "systemd user instance unreachable. Make sure you're in a real login session (XDG_RUNTIME_DIR must be set)."

  LOG_DIR="$HOME/.local/state"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$LOG_DIR" "$UNIT_DIR"

  cat > "$UNIT_DIR/${SERVICE}.service" <<EOF
[Unit]
Description=yescode-proxy (OpenClaw <-> yes.vg passthrough)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=2
StandardOutput=append:$LOG_DIR/${SERVICE}.log
StandardError=append:$LOG_DIR/${SERVICE}.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE}.service"
  log "systemd unit installed and started"

  if command -v loginctl >/dev/null 2>&1 \
     && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes'; then
    warn "linger not enabled — service stops on logout. To fix: sudo loginctl enable-linger $USER"
  fi

  if command -v logrotate >/dev/null 2>&1; then
    LOGROTATE_DIR="$HOME/.config/logrotate"
    mkdir -p "$LOGROTATE_DIR"
    cat > "$LOGROTATE_DIR/${SERVICE}.conf" <<EOF
$LOG_DIR/${SERVICE}.log {
    daily
    rotate 7
    maxsize 100M
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    dateext
    dateformat -%Y%m%d-%s
}
EOF
    cat > "$UNIT_DIR/${SERVICE}-logrotate.service" <<EOF
[Unit]
Description=Rotate ${SERVICE} log

[Service]
Type=oneshot
ExecStart=$(command -v logrotate) --state $LOG_DIR/${SERVICE}-logrotate.state $LOGROTATE_DIR/${SERVICE}.conf
EOF
    cat > "$UNIT_DIR/${SERVICE}-logrotate.timer" <<EOF
[Unit]
Description=${SERVICE} log rotation (hourly check)
Requires=${SERVICE}-logrotate.service

[Timer]
OnCalendar=hourly
Persistent=true
AccuracySec=5m

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE}-logrotate.timer"
    log "logrotate timer installed (hourly check, daily or 100MB rotation)"
  else
    warn "logrotate not installed — logs will grow without bound. apt/dnf/pacman install logrotate to fix."
  fi

elif [ "$PLATFORM" = macos ]; then
  PLIST_LABEL="com.openclaw.${SERVICE}"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/${PLIST_LABEL}.plist"
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${INSTALL_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>YESCODE_ENV_FILE</key><string>${ENV_FILE}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/${SERVICE}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/${SERVICE}.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  log "launchd plist loaded"
  warn "macOS log rotation not configured — install logrotate (brew) or configure newsyslog for long-running deploys."
fi

log "waiting for service to come up…"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    log "yescode-proxy listening on http://127.0.0.1:${PORT}"
    exit 0
  fi
done

if [ "$PLATFORM" = linux ]; then
  die "health check failed. Check:  journalctl --user -u ${SERVICE} -n 30"
else
  die "health check failed. Check:  tail -n 30 $LOG_DIR/${SERVICE}.log"
fi
