---
name: secrets-regression-check
description: Scan diffs and API/sanitize paths for leaked secrets, missing redaction, or unsafe logging. Use after auth/credential/settings/API changes, before commits touching secret-storage or Bluesky accounts, or when the user asks for a secrets review.
---

# Secrets regression check

## Scan

1. `git diff` / changed files for: `appPassword`, `bskyPassword`, `authToken`, `ct0`, `apiKey`, `webhook`, `Authorization`, `password:`.
2. Confirm API responses and logs use sanitization helpers — raw secrets never returned.
3. Confirm new config secret fields are covered by encryption in `secret-storage` when `CONFIG_ENCRYPTION_KEY` is set.
4. Fixtures/tests use placeholders like `redacted` / `xox-test-not-real` — not production-shaped secrets.
5. Refuse to stage: `.env`, `config.json*`, `data/**`, `*.sqlite*`.

## Pass criteria

- No secret values in diff
- No new log lines printing credentials
- Account validate/rotate paths do not return `appPassword`
- Docs/examples stay redacted

If issues found, list file:line and required fix before merge.
