#!/bin/sh
# Runs the app as the unprivileged bun user (uid 1000). Volumes created by
# earlier images are root-owned, so when started as root this hands the data
# directory to bun once, then drops privileges for the real process.
set -eu

APP_UID=1000
APP_GID=1000
DATA_DIR="${TWEETS2BSKY_DATA_DIR:-/app/data}"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

mkdir -p "$DATA_DIR"
if [ -n "$(find "$DATA_DIR" \( ! -uid "$APP_UID" -o ! -gid "$APP_GID" \) -print -quit)" ]; then
  echo "[entrypoint] Giving $DATA_DIR to uid $APP_UID so the app can run without root."
  if ! chown -R "$APP_UID:$APP_GID" "$DATA_DIR"; then
    echo "[entrypoint] Could not change ownership of $DATA_DIR; staying root so existing data stays writable." >&2
    exec "$@"
  fi
fi

if ! setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups true 2>/dev/null; then
  echo "[entrypoint] Cannot drop privileges here (missing SETUID/SETGID capability); running as root." >&2
  exec "$@"
fi
export HOME=/home/bun
exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups "$@"
