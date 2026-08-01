#!/usr/bin/env bun
/**
 * Codex PostToolUse hook: add a concise reminder when an apply_patch edit
 * touches migration, config, database, or credential paths.
 */
const input = await Bun.stdin.text();
let payload;
try {
  payload = JSON.parse(input || '{}');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

const toolName = String(payload.tool_name ?? '');
if (!['apply_patch', 'Edit', 'Write'].includes(toolName)) {
  process.stdout.write('{}');
  process.exit(0);
}

const toolInput = payload.tool_input ?? {};
const searchable = JSON.stringify(toolInput).replace(/\\\\/g, '/');
const hints = [];

if (/src\/config\/(migrations|normalize|schemas)\.ts|config-manager\.ts/.test(searchable)) {
  hints.push(
    'Config migration path edited: run focused migration tests, keep the data directory temporary, and sync schema docs.',
  );
}
if (/src\/db\/migrations\/|src\/db\.ts/.test(searchable)) {
  hints.push(
    'SQLite migration path edited: run tests/integration/database-migrations.test.ts with a temporary TWEETS2BSKY_DATA_DIR.',
  );
}
if (/secret-storage\.ts|bluesky-accounts/.test(searchable)) {
  hints.push('Credential-related edit: run secrets-regression-check before finishing.');
}

if (hints.length === 0) {
  process.stdout.write('{}');
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: hints.join(' '),
    },
  }),
);
