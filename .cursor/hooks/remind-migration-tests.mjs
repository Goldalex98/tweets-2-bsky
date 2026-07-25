#!/usr/bin/env bun
/**
 * postToolUse (Write): remind agent to run focused migration tests when
 * config/db migration files were written.
 */
const input = await Bun.stdin.text();
let payload;
try {
  payload = JSON.parse(input || '{}');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

const path = String(
  payload.tool_input?.path ??
    payload.toolInput?.path ??
    payload.path ??
    payload.arguments?.path ??
    '',
).replace(/\\/g, '/');

const hints = [];
if (/src\/config\/(migrations|normalize|schemas)\.ts$/.test(path) || /config-manager\.ts$/.test(path)) {
  hints.push(
    'Config migration file edited: run unit migration tests and consider skill sync-schema-docs. Do not use real data/config.json.',
  );
}
if (/src\/db\/migrations\//.test(path) || /src\/db\.ts$/.test(path)) {
  hints.push(
    'SQLite migration path edited: run tests/integration/database-migrations.test.ts with a temp TWEETS2BSKY_DATA_DIR.',
  );
}
if (/secret-storage\.ts$/.test(path) || /bluesky-accounts/.test(path)) {
  hints.push('Credential-related edit: run skill secrets-regression-check before finishing.');
}

if (hints.length === 0) {
  process.stdout.write('{}');
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    additional_context: hints.join(' '),
  }),
);
