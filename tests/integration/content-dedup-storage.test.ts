import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('duplicate windows remain destination and route scoped', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'dedup.json');
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { duplicateFingerprintService: service } = await import(${JSON.stringify(dbModuleUrl)});
          service.record({
            destinationId: 'destination-a',
            routeId: 'route-a',
            externalPostId: 'post-1',
            textUrlHash: 'hash-1',
            createdAt: 100,
          });
          const result = {
            sameDestination: service.findRecent({
              destinationId: 'destination-a', textUrlHash: 'hash-1', since: 50,
            }),
            otherDestination: service.findRecent({
              destinationId: 'destination-b', textUrlHash: 'hash-1', since: 50,
            }),
            expired: service.findRecent({
              destinationId: 'destination-a', textUrlHash: 'hash-1', since: 101,
            }),
            otherRoute: service.findRecent({
              destinationId: 'destination-a', routeId: 'route-b', routeScoped: true,
              textUrlHash: 'hash-1', since: 50,
            }),
          };
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    expect(result.sameDestination).toMatchObject({ externalPostId: 'post-1', routeId: 'route-a' });
    expect(result.otherDestination).toBeNull();
    expect(result.expired).toBeNull();
    expect(result.otherRoute).toBeNull();
  } finally {
    temporary.cleanup();
  }
});
