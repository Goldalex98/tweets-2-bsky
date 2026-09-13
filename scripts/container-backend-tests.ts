import path from 'node:path';
import { runCommand } from './validate-image.js';

// This mode runs source integration fixtures in the candidate's runtime/dependency
// environment. validate-image separately checks the published compiled application.
// No ports, real data, host environment, credentials, or production settings are mounted.
export const backendFixtureSuites = [
  'tests/integration/security-auth-api.test.ts',
  'tests/integration/session-lifecycle-api.test.ts',
  'tests/integration/aggregate-source-api.test.ts',
  'tests/integration/destination-bluesky-account-link-api.test.ts',
  'tests/integration/bluesky-account-block-api.test.ts',
  'tests/integration/bluesky-account-block-persistence.test.ts',
  'tests/integration/health-queue-api.test.ts',
  'tests/integration/normalized-ingestion-api.test.ts',
  'tests/integration/backup-restore.test.ts',
];

export async function testContainerBackend(image: string): Promise<void> {
  if (!image || image.startsWith('-') || /\s/.test(image))
    throw new Error('Provide a candidate image or immutable digest');
  const root = path.resolve(import.meta.dir, '..');
  const container = `tweets-2-bsky-backend-fixtures-${process.pid}-${Date.now()}`;
  try {
    const args = [
      'run',
      '--name',
      container,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs=/tmp:rw,nosuid,size=512m',
      '--tmpfs=/app/data:rw,nosuid,size=128m',
      '--env=NODE_ENV=test',
      '--env=TWEETS2BSKY_DATA_DIR=/tmp/container-fixture-bootstrap',
      '--entrypoint=bun',
    ];
    for (const directory of ['src', 'tests']) {
      args.push('--mount', `type=bind,source=${path.join(root, directory)},target=/app/${directory},readonly`);
    }
    args.push(image, 'test', ...backendFixtureSuites);
    console.log(await runCommand('docker', args, 600_000));
    console.log(
      'Real-backend source integration fixtures passed inside the isolated candidate runtime (no external network).',
    );
  } finally {
    await runCommand('docker', ['rm', '--force', '--volumes', container]).catch(() => undefined);
  }
}

if (import.meta.main) {
  const imageIndex = process.argv.indexOf('--image');
  const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : undefined;
  if (!image) throw new Error('Usage: bun scripts/container-backend-tests.ts --image <candidate-or-digest>');
  await testContainerBackend(image);
}
