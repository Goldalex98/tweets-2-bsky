import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTemporaryDataDir, type TemporaryDataDir } from '../helpers/temporary-data-dir.js';

// Every case boots at least one real CLI process, which is far slower than the default budget.
const CLI_TIMEOUT_MS = 60_000;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliEntry = path.join(repositoryRoot, 'src', 'cli.ts');
const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;

let temporary: TemporaryDataDir;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(...args: string[]): Promise<CliResult> {
  const subprocess = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: repositoryRoot,
    env: temporary.env,
    stdout: 'pipe',
    stderr: 'pipe',
  }, CLI_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function seedAggregateDestination(): Promise<void> {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
        const configManager = await import(${JSON.stringify(configManagerModuleUrl)});
        configManager.addMapping({
          twitterUsernames: ['alpha', 'beta'],
          bskyIdentifier: 'aggregate.example',
          bskyPassword: '<redacted>',
          bskyServiceUrl: 'https://bsky.social'
        });
      `,
    ],
    { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
}

function readConfig(): { scheduler: { enabled: boolean; intervalMinutes: number; runOnStartup: boolean } } {
  return JSON.parse(fs.readFileSync(path.join(temporary.path, 'config.json'), 'utf8'));
}

/** Config is persisted canonically, so policies are read back the way an operator sees them. */
function parseJsonBlock(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  expect(start, `no JSON payload in CLI output: ${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start, end + 1));
}

async function readAttributionPolicy(): Promise<{ attribution: { mode: string; template: string } }> {
  const result = await runCli('attribution-policy', 'aggregate.example');
  expect(result.exitCode, result.stderr).toBe(0);
  return parseJsonBlock(result.stdout) as { attribution: { mode: string; template: string } };
}

async function readProfilePolicy(): Promise<{
  allowProfileMutation: boolean;
  profileSync: { mode: string };
  pinSync: { mode: string };
}> {
  const result = await runCli('profile-policy', 'aggregate.example');
  expect(result.exitCode, result.stderr).toBe(0);
  return parseJsonBlock(result.stdout) as {
    allowProfileMutation: boolean;
    profileSync: { mode: string };
    pinSync: { mode: string };
  };
}

beforeEach(() => {
  temporary = createTemporaryDataDir();
});

afterEach(() => {
  temporary.cleanup();
});

describe('cli scheduler interval parity', () => {
  test('set-interval persists the interval and explains when a daemon applies it', async () => {
    const result = await runCli('set-interval', '17');

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('Interval set to 17 minutes.');
    expect(result.stdout).toContain('next scheduled cycle');
    expect(readConfig().scheduler.intervalMinutes).toBe(17);
  }, CLI_TIMEOUT_MS);

  test('set-interval enforces the same bounds as the settings API', async () => {
    const tooSmall = await runCli('set-interval', '0');
    const tooLarge = await runCli('set-interval', '1441');
    const fractional = await runCli('set-interval', '2.5');

    for (const result of [tooSmall, tooLarge, fractional]) {
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('whole number between 1 and 1440');
    }
  }, CLI_TIMEOUT_MS);

  test('scheduler-set updates enablement and interval together', async () => {
    const result = await runCli('scheduler-set', '--interval', '30', '--enabled', 'false', '--run-on-startup', 'true');

    expect(result.exitCode, result.stderr).toBe(0);
    expect(readConfig().scheduler).toMatchObject({ enabled: false, intervalMinutes: 30, runOnStartup: true });
  }, CLI_TIMEOUT_MS);
});

describe('cli attribution parity', () => {
  test('a bulk-added aggregate destination reports attribution as active', async () => {
    await seedAggregateDestination();
    const result = await runCli('attribution-policy', 'aggregate.example');

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('"mode": "multiple-sources"');
    expect(result.stdout).toContain('active because this destination has 2 X sources');
  }, CLI_TIMEOUT_MS);

  test('an unsupported template variable is rejected before the config is written', async () => {
    await seedAggregateDestination();
    const result = await runCli('attribution-policy', 'aggregate.example', '--template', 'From {handle}');

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('unsupported variable: {handle}');
    expect((await readAttributionPolicy()).attribution.template).toBe('Source: @{username} on X');
  }, CLI_TIMEOUT_MS);

  test('attribution can be turned off for a one-to-one mirror', async () => {
    await seedAggregateDestination();
    const result = await runCli('attribution-policy', 'aggregate.example', '--mode', 'never');

    expect(result.exitCode, result.stderr).toBe(0);
    expect((await readAttributionPolicy()).attribution.mode).toBe('never');
  }, CLI_TIMEOUT_MS);
});

describe('cli profile mutation safety', () => {
  test('onboarding leaves profile mutation disabled', async () => {
    await seedAggregateDestination();

    expect(await readProfilePolicy()).toMatchObject({
      allowProfileMutation: false,
      profileSync: { mode: 'off' },
      pinSync: { mode: 'off' },
    });
  }, CLI_TIMEOUT_MS);

  test('sync-profile refuses while mutation is disabled', async () => {
    await seedAggregateDestination();
    const result = await runCli('sync-profile', 'aggregate.example');

    expect(result.stdout).toContain('Profile mutation is disabled for this destination.');
  }, CLI_TIMEOUT_MS);

  test('allowing mutation alone still does not authorize a profile write', async () => {
    await seedAggregateDestination();
    const allowed = await runCli('profile-policy', 'aggregate.example', '--allow-mutation', 'true');
    const attempted = await runCli('sync-profile', 'aggregate.example');

    expect(allowed.exitCode, allowed.stderr).toBe(0);
    const stored = await readProfilePolicy();
    expect(stored.allowProfileMutation).toBe(true);
    expect(stored.profileSync.mode).toBe('off');
    expect(attempted.stdout).toContain('Manual profile synchronization is not enabled for this destination.');
  }, CLI_TIMEOUT_MS);
});
