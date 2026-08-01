#!/usr/bin/env bun
/**
 * Codex PreToolUse hook: deny git add commands that reference obvious
 * sensitive runtime paths. This is a guardrail; .gitignore and review remain
 * the source of truth.
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
const command = String(payload.tool_input?.command ?? '');

if (toolName !== 'Bash' || !/\bgit\s+add\b/i.test(command)) {
  process.stdout.write('{}');
  process.exit(0);
}

const sensitivePath =
  /(^|[\s"'`])(?:\.env(?:[\s"'`.]|$)|config\.json[\w.-]*(?:[\s"'`]|$)|data[\\/]|[^\\/\s"'`]+\.sqlite(?:-wal|-shm)?(?:[\s"'`]|$)|\.jwt-secret(?:[\s"'`]|$))/i;

if (sensitivePath.test(command)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Blocked: git add references sensitive runtime paths (.env, config.json*, data/, sqlite, or .jwt-secret). Use redacted fixtures and stage explicit safe paths.',
      },
    }),
  );
  process.exit(0);
}

process.stdout.write('{}');
