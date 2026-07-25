---
name: feature-destination-or-account
description: Touch-point checklist for Destination or BlueskyAccount fields across schema, normalize, projection, secrets, services, routes, and dashboard. Use when adding/changing account or destination identity, credentials, health, or Settings/Destinations UI.
---

# Destination / Bluesky account feature

## Layer checklist

```
- [ ] src/config/schemas.ts types
- [ ] normalize (destination / blueskyAccount) + assertValidAppConfig
- [ ] defaults / create helpers (src/config/bluesky-accounts.ts)
- [ ] projection.ts (AccountMapping fill from account)
- [ ] secret-storage encryption paths for new secrets
- [ ] services (bluesky-account-service, runtime) + agent cache eviction if credentials change
- [ ] routes (bluesky-accounts-router, destinations) + OCC revision
- [ ] API sanitization (never return appPassword)
- [ ] web types + hooks + Settings/Destinations UI
- [ ] unit/integration tests + fixtures redacted
```

## Invariants

- One destination ↔ one `bskyAccountId` max.
- Credentials on account; destination keeps `storageKey` + public identity fields.
- Validate = read-only Bluesky login.
- Rotate password → update encrypted secret + clear cached agent.
- Delete account still linked → `409`.

## Afterward

Run `run-quality-gate`. Consider subagent `config-integrity` for review.
