import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');

function which(command: string): string | undefined {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/** True for real Node; false for Bun (which also reports `process.versions.node`). */
function isRealNode(executable: string): boolean {
  const result = spawnSync(
    executable,
    ['-e', 'process.exit(process.versions.bun ? 2 : process.versions.node ? 0 : 1)'],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.status === 0;
}

function resolveWindowsNode(): string {
  const candidates = [
    process.env.PLAYWRIGHT_NODE,
    which('node'),
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Programs',
      'cursor',
      'resources',
      'app',
      'resources',
      'helpers',
      'node.exe',
    ),
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Programs',
      'Cursor',
      'resources',
      'app',
      'resources',
      'helpers',
      'node.exe',
    ),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (isRealNode(candidate)) return candidate;
  }

  console.error(
    [
      'Playwright on Windows requires Node.js.',
      "Bun cannot complete Playwright's --remote-debugging-pipe handshake, so the browser",
      'process starts and then times out after launch.',
      '',
      'Install Node.js, or set PLAYWRIGHT_NODE to a node.exe path.',
      'Cursor ships one at:',
      String.raw`  %LOCALAPPDATA%\Programs\cursor\resources\app\resources\helpers\node.exe`,
    ].join('\n'),
  );
  process.exit(1);
}

const playwrightArgs = process.argv.slice(2);
if (playwrightArgs.length === 0) playwrightArgs.push('test');

const runtime =
  process.platform === 'win32'
    ? { command: resolveWindowsNode(), args: [cli, ...playwrightArgs] }
    : { command: process.execPath, args: [cli, ...playwrightArgs] };

const child = spawn(runtime.command, runtime.args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  // Always exit explicitly. Re-raising the child's signal and returning can leave
  // this wrapper hanging when the signal is unsupported or ignored (common on Windows).
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
