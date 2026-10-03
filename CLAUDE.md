@AGENTS.md

## Claude Code equivalents
AGENTS.md is authoritative. Claude discovers the same workflows here:
- Skills: `.claude/skills` is a symlink to `.agents/skills`, so there's one copy.
- Subagents: `.claude/agents/` has `config-integrity`, `pipeline-regression`, `quality-gate` and `release-verifier` (all Sonnet, medium effort). Each has a Codex copy (`.codex/agents/*.toml`) and a Cursor mirror (`.cursor/agents/`). When a workflow changes, update all three. Agents run gate commands as plain `bun run <script>` so they match `.claude/settings.json` allow rules; the test suites isolate their own data dirs.
- Handoff: read `.claude/HANDOFF.md` at session start and update it before ending.
- Hooks: `.claude/settings.json` runs the existing `.codex/hooks/*.mjs` scripts (sensitive `git add` block, migration-test reminders). There are no separate Claude copies.
- Cloud sessions: `.claude/hooks/session-start.sh` (SessionStart) installs the pinned Bun from npm (bun.sh is blocked there) and runs `bun install --frozen-lockfile`. It no-ops outside `CLAUDE_CODE_REMOTE`.
- Linux: this checkout runs on Debian; `bun` is at `~/.local/bin/bun`. Ignore the Windows PATH/PowerShell notes. Run gates with a temporary data dir: `TWEETS2BSKY_DATA_DIR=$(mktemp -d) APP_DATA_DIR=$(mktemp -d) bun run check`.
