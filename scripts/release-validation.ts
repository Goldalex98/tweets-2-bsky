import { spawn } from 'node:child_process';
import { testContainerBackend } from './container-backend-tests.js';
import { runCommand, validateImage } from './validate-image.js';

const run = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });

const dockerRequested = process.argv.includes('--docker');
const imageFlag = process.argv.indexOf('--image');
if (imageFlag >= 0) {
  const image = process.argv[imageFlag + 1];
  if (!image) throw new Error('--image requires an immutable image digest');
  const copyFlag = process.argv.indexOf('--copied-volume');
  const copyPath = copyFlag >= 0 ? process.argv[copyFlag + 1] : undefined;
  if (copyFlag >= 0 && !copyPath) throw new Error('--copied-volume requires a protected snapshot directory');
  await validateImage(image, true, copyPath);
  process.exit(0);
}

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
  const image = 'tweets-2-bsky:release-validation';
  await runCommand('docker', ['build', '--tag', image, '.'], 900_000);
  await validateImage(image, false);
  await testContainerBackend(image);
}

console.log(
  dockerRequested
    ? 'Release validation passed, including a running Docker container and healthy /readyz response.'
    : 'Release validation passed. Re-run with --docker to include the environment-dependent Docker build.',
);
