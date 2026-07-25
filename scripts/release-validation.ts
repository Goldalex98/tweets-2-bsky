import { spawn } from 'node:child_process';

const run = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });

const runCapture = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`)),
    );
  });

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function validateDockerHealth(): Promise<void> {
  const image = 'tweets-2-bsky:release-validation';
  const container = `tweets-2-bsky-release-${process.pid}-${Date.now()}`;
  const port = 43_000 + Math.floor(Math.random() * 1_000);
  await run('docker', ['build', '--tag', image, '.']);
  try {
    await runCapture('docker', [
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      `127.0.0.1:${port}:3000`,
      '--env',
      'JWT_SECRET=release-validation-only-not-a-production-secret',
      image,
    ]);
    const deadline = Date.now() + 100_000;
    let lastHealth = 'starting';
    while (Date.now() < deadline) {
      lastHealth = await runCapture('docker', ['inspect', '--format={{.State.Health.Status}}', container]);
      if (lastHealth === 'unhealthy') {
        throw new Error(`Docker container became unhealthy.\n${await runCapture('docker', ['logs', container])}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        const payload = (await response.json()) as { status?: string };
        if (response.ok && payload.status === 'ready' && lastHealth === 'healthy') return;
      } catch {
        // The published port can become reachable before the image healthcheck completes.
      }
      await delay(2_000);
    }
    throw new Error(`Docker health validation timed out with container status ${lastHealth}.`);
  } finally {
    await run('docker', ['rm', '--force', container]).catch(() => undefined);
  }
}

const dockerRequested = process.argv.includes('--docker');

await run('bun', [
  'test',
  'tests/release',
  'tests/integration/config-migration-storage.test.ts',
  'tests/integration/database-migrations.test.ts',
  'tests/integration/backup-restore.test.ts',
  'tests/integration/aggregate-storage-actions.test.ts',
  'tests/integration/health-queue-api.test.ts',
  'tests/integration/operations-observability.test.ts',
  'tests/integration/normalized-routing-digest.test.ts',
]);
await run('bun', ['run', 'test:e2e']);

if (dockerRequested) {
  await validateDockerHealth();
}

console.log(
  dockerRequested
    ? 'Release validation passed, including a running Docker container and healthy /readyz response.'
    : 'Release validation passed. Re-run with --docker to include the environment-dependent Docker build.',
);
