# Config schema v6 migration and rollback

Before upgrading, run a read-only report:

```sh
bun src/cli.ts config-migration-report /path/to/config.json
```

The report contains entity counts, deduplication counts, conflicting field
names, and legacy mapping IDs. It never contains credential values. Any
duplicate Bluesky identity with conflicting credentials, ownership, policy, or
route state blocks the migration.

On the first successful legacy load, the application writes the original bytes
to applicable `config.json.pre-vN-backup` files before replacing `config.json`.
Backups are created once and are not refreshed. Loading the migrated file again
is byte-stable.

Canonical v6 shape (sanitized and abbreviated only where arrays are empty):

```json
{
  "schemaVersion": 6,
  "revision": 14,
  "updatedAt": "2026-07-24T20:00:00.000Z",
  "twitter": {
    "authToken": "<encrypted-or-redacted>",
    "ct0": "<encrypted-or-redacted>"
  },
  "sources": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "type": "x",
      "username": "example",
      "enabled": true,
      "filters": {
        "originalPosts": true,
        "selfReplies": true,
        "externalReplies": false,
        "quotes": true,
        "reposts": false,
        "mediaOnly": false,
        "includeKeywords": [],
        "excludeKeywords": [],
        "languages": [],
        "sensitiveContent": "mirror"
      },
      "schedule": {
        "mode": "inherit",
        "minIntervalMinutes": 2,
        "maxIntervalMinutes": 60,
        "fixedIntervalMinutes": 5,
        "timezone": "UTC"
      },
      "state": {"consecutiveFailures": 0}
    }
  ],
  "destinations": [
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "enabled": true,
      "bskyIdentifier": "example.bsky.social",
      "bskyPassword": "<encrypted-or-redacted>",
      "bskyServiceUrl": "https://bsky.social",
      "storageKey": "destination:00000000-0000-4000-8000-000000000002"
    }
  ],
  "routes": [
    {
      "id": "00000000-0000-4000-8000-000000000003",
      "sourceId": "00000000-0000-4000-8000-000000000001",
      "destinationId": "00000000-0000-4000-8000-000000000002",
      "enabled": true,
      "delivery": {"mode": "immediate"}
    }
  ],
  "groups": [],
  "users": [],
  "scheduler": {"enabled": true, "intervalMinutes": 5, "runOnStartup": false},
  "notifications": {"enabled": false},
  "ai": {"enabled": false, "purpose": "image-alt-text", "provider": "gemini"}
}
```

Normal persisted output includes complete normalized policy objects. The
compatibility `mappings` projection is runtime/API-only and is not written.

To roll back:

1. Stop the application.
2. Preserve the current data directory as an additional backup.
3. Copy the backup matching the previous release's maximum readable schema over `config.json`.
4. Start the previous release.
5. Verify destination ownership, source routes, queue depth, and recent
   delivery history.

SQLite upgrades are additive and retain the legacy primary keys and columns,
so restoring the database is normally unnecessary. Restore the pre-upgrade
database backup only if the older release cannot tolerate the added columns.
