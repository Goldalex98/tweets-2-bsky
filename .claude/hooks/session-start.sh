#!/usr/bin/env bash
# Cloud sessions only: install the Bun version pinned in package.json and the
# project dependencies. bun.sh is not reachable there, so Bun comes from npm.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
pinned=$(node -p "require('./package.json').packageManager.replace(/^bun@/, '')")

if [ "$(bun --version 2>/dev/null || true)" != "$pinned" ]; then
  npm install -g "bun@${pinned}" >/dev/null
  hash -r
fi

bun install --frozen-lockfile
