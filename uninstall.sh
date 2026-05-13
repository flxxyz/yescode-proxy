#!/usr/bin/env bash
set -euo pipefail

# Uninstaller for yescode-proxy. Reverses install.sh.
#   Linux: stops & removes systemd user units + logrotate config
#   macOS: unloads & removes the LaunchAgent
#
# By default keeps .env (your API key) and log files. Pass flags to wipe them.
#
# Usage: ./uninstall.sh [--purge-logs] [--purge-env] [-y]
#   --purge-logs   also delete the proxy log + rotated archives
#   --purge-env    also delete .env (WARNING: contains YESCODE_API_KEY)
#   -y, --yes      skip the confirmation prompt
#
# Optional env vars:
#   INSTALL_DIR=/path/to/dir    where .env lives (default: script's own dir)
#
# The source tree (this repo) is never touched — rm -rf it yourself if you want.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
SERVICE="yescode-proxy"

PURGE_LOGS=0
PURGE_ENV=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge-logs) PURGE_LOGS=1 ;;
    --purge-env)  PURGE_ENV=1 ;;
    --purge)      PURGE_LOGS=1; PURGE_ENV=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)
      sed -n '4,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[36m[uninstall]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[uninstall]\033[0m %s\n' "$*"; }
miss() { printf '\033[90m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[uninstall]\033[0m %s\n' "$*" >&2; }

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) warn "unsupported OS: $(uname -s)"; exit 1 ;;
esac

log "platform=$PLATFORM  install_dir=$INSTALL_DIR"
[ "$PURGE_LOGS" -eq 1 ] && log "logs will be deleted"
[ "$PURGE_ENV"  -eq 1 ] && warn ".env will be deleted (contains your API key)"

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Continue? [y/N] '
  read -r confirm
  case "$confirm" in y|Y|yes|YES) ;; *) log "aborted."; exit 0 ;; esac
fi

if [ "$PLATFORM" = linux ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  LOG_DIR="$HOME/.local/state"
  LOGROTATE_DIR="$HOME/.config/logrotate"

  # Disable + stop units that have an [Install] section. Failures are fine
  # (unit may be gone or never enabled).
  for unit in "${SERVICE}-logrotate.timer" "${SERVICE}.service"; do
    if [ -f "$UNIT_DIR/$unit" ]; then
      systemctl --user disable --now "$unit" 2>/dev/null || true
      ok "stopped & disabled $unit"
    else
      miss "$unit not installed"
    fi
  done

  # Remove unit files (main service, logrotate oneshot, logrotate timer).
  for f in \
    "$UNIT_DIR/${SERVICE}.service" \
    "$UNIT_DIR/${SERVICE}-logrotate.service" \
    "$UNIT_DIR/${SERVICE}-logrotate.timer"; do
    if [ -f "$f" ]; then
      rm -f "$f"
      ok "removed $f"
    fi
  done

  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user reset-failed "${SERVICE}.service"            2>/dev/null || true
  systemctl --user reset-failed "${SERVICE}-logrotate.service"  2>/dev/null || true

  # logrotate config + state
  if [ -f "$LOGROTATE_DIR/${SERVICE}.conf" ]; then
    rm -f "$LOGROTATE_DIR/${SERVICE}.conf"
    ok "removed $LOGROTATE_DIR/${SERVICE}.conf"
  else
    miss "$LOGROTATE_DIR/${SERVICE}.conf not present"
  fi
  if [ -f "$LOG_DIR/${SERVICE}-logrotate.state" ]; then
    rm -f "$LOG_DIR/${SERVICE}-logrotate.state"
    ok "removed logrotate state file"
  fi

  # Logs: current + rotated archives
  if compgen -G "$LOG_DIR/${SERVICE}.log*" >/dev/null; then
    if [ "$PURGE_LOGS" -eq 1 ]; then
      n=$(find "$LOG_DIR" -maxdepth 1 -name "${SERVICE}.log*" | wc -l)
      find "$LOG_DIR" -maxdepth 1 -name "${SERVICE}.log*" -delete
      ok "deleted $n log file(s) from $LOG_DIR"
    else
      log "kept $LOG_DIR/${SERVICE}.log* (use --purge-logs to delete)"
    fi
  else
    miss "no log files in $LOG_DIR"
  fi

elif [ "$PLATFORM" = macos ]; then
  PLIST_LABEL="com.openclaw.${SERVICE}"
  PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
  LOG_DIR="$HOME/Library/Logs"

  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    ok "unloaded & removed $PLIST"
  else
    miss "$PLIST not present"
  fi
  # Defensive: drop any stale registration by label.
  launchctl remove "$PLIST_LABEL" 2>/dev/null || true

  if [ -f "$LOG_DIR/${SERVICE}.log" ]; then
    if [ "$PURGE_LOGS" -eq 1 ]; then
      rm -f "$LOG_DIR/${SERVICE}.log"
      ok "deleted $LOG_DIR/${SERVICE}.log"
    else
      log "kept $LOG_DIR/${SERVICE}.log (use --purge-logs to delete)"
    fi
  else
    miss "no log file at $LOG_DIR/${SERVICE}.log"
  fi
fi

ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  if [ "$PURGE_ENV" -eq 1 ]; then
    rm -f "$ENV_FILE"
    ok "deleted $ENV_FILE"
  else
    log "kept $ENV_FILE (use --purge-env to delete; contains your API key)"
  fi
else
  miss "$ENV_FILE not present"
fi

ok "uninstall complete."
log "source tree at $INSTALL_DIR was NOT touched — rm -rf it manually if you want."
