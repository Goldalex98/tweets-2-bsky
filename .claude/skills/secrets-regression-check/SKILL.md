---
name: secrets-regression-check
description: Scan a diff and related API paths for leaked credentials, missing redaction, unsafe logging, or unencrypted new secret fields. Use after auth, credential, settings, or Bluesky account changes.
---

# Secrets regression check

1. Scan changed files and related paths for `appPassword`, `bskyPassword`,
   `authToken`, `ct0`, `apiKey`, `webhook`, `Authorization`, and password
   fields.
2. Confirm API responses and logs use sanitization helpers.
3. Confirm new config secret fields are covered by `secret-storage` when
   `CONFIG_ENCRYPTION_KEY` is set.
4. Confirm fixtures use placeholders such as `redacted`, never production-shaped
   cookies or passwords.
5. Refuse to stage `.env`, `config.json*`, `data/**`, and `*.sqlite*`.

Pass only when the diff has no secret values or credential logs, account
validate/rotate paths do not return `appPassword`, and docs/examples remain
redacted. Report each issue with file and line plus a concrete fix.
