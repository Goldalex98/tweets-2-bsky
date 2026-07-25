#!/usr/bin/env bun
/**
 * beforeShellExecution: deny staging obvious sensitive paths via git add.
 * Reads hook JSON from stdin; writes permission JSON to stdout.
 */
const input = await Bun.stdin.text();
let payload;
try {
  payload = JSON.parse(input || '{}');
} catch {
  process.stdout.write(JSON.stringify({ permission: 'allow' }));
  process.exit(0);
}

const command = String(payload.command ?? '');

// Only gate `git add` path args (not commit messages that mention "data/").
if (!/\bgit\s+add\b/i.test(command)) {
  process.stdout.write(JSON.stringify({ permission: 'allow' }));
  process.exit(0);
}

const sensitivePath =
  /(^|[\s"'])(\.env(?:\b|\.)|config\.json[\w.-]*\b|data\/|[^/\s"'`]+\.sqlite(?:-wal|-shm)?\b|\.jwt-secret\b)/i;

if (sensitivePath.test(command)) {
  process.stdout.write(
    JSON.stringify({
      permission: 'deny',
      user_message:
        'Blocked: git add references sensitive runtime paths (.env, config.json, data/, sqlite).',
      agent_message:
        'Do not stage .env, config.json*, data/, or *.sqlite*. Use redacted fixtures only. Re-run without those paths.',
    }),
  );
  process.exit(0);
}

process.stdout.write(JSON.stringify({ permission: 'allow' }));
