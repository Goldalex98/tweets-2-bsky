# Agent guide (tweets-2-bsky)

Concise project instructions for AI agents. Prefer these over pasting whole docs.

## Where guidance lives

| Kind | Path | When |
|------|------|------|
| Always-on rules | `.cursor/rules/core-invariants.mdc` | Every chat |
| Scoped rules | `.cursor/rules/*.mdc` | Matching files open/edited |
| Skills | `.cursor/skills/*/SKILL.md` | Multi-step workflows (auto-discover) |
| Slash commands | `.cursor/commands/` | `/check`, `/mig-config`, `/mig-db`, `/sync-docs`, `/secrets-scan` |
| Subagents | `.cursor/agents/` | `config-integrity`, `pipeline-regression` |
| Human docs | `docs/architecture.md`, `docs/operations.md`, … | Deep reference only when needed |

## Identity (schema v7)

`Source -> Route -> Destination -> BlueskyAccount` — credentials on the account; `AccountMapping` is projection only.

## Quality

Use skill `run-quality-gate`. Full suite: `bun run check`. Never run live `test:pipeline` / `test:twitter-*` in offline CI.

## Copilot

GitHub Copilot still reads `.github/copilot-instructions.md` (kept short; details in `.cursor/rules/`).
