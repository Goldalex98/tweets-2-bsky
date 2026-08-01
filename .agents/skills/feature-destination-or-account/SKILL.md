---
name: feature-destination-or-account
description: Trace a Destination or BlueskyAccount field through schema, normalization, projection, secrets, services, routes, dashboard, and tests. Use for account or destination identity, credentials, health, or settings changes.
---

# Destination / Bluesky account feature

## Layer checklist

- `src/config/schemas.ts`, normalize, defaults, and `assertValidAppConfig`
- `src/config/projection.ts` and secret-storage encryption paths
- account services, runtime agent-cache eviction, and health recording
- account/destination routes with revision/OCC checks
- sanitized API types (never return `appPassword`)
- web types, hooks, Settings/Destinations UI, redacted fixtures, and tests

## Invariants

- One destination may reference one `bskyAccountId`, and an account may not be
  linked to multiple destinations.
- Credentials live on the account; the destination keeps public identity and
  `storageKey`.
- Validate is a read-only Bluesky login.
- Rotating a password updates encrypted storage and clears the cached agent.
- Deleting a linked account returns `409`.

Run `run-quality-gate` afterward and request the `config_integrity` custom
agent for a focused review when useful.
