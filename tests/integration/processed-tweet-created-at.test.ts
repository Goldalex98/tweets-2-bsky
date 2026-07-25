import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;

test('saveTweet preserves created_at on replace so restored skips stay older than queue items', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { dbService, parseSqliteUtcTimestampMs } = await import(${JSON.stringify(dbModuleUrl)});
          dbService.saveTweet({
            twitter_id: 'collision-1',
            twitter_username: 'source',
            bsky_identifier: 'destination.example',
            destination_id: 'destination.example',
            status: 'skipped',
            skip_reason: 'moderation-blocked-keyword',
          });
          const original = dbService.getTweet('collision-1', 'destination.example');
          await Bun.sleep(1100);
          const enqueuedAt = Date.now();
          dbService.saveTweet({
            ...original,
            override_requeued_at: undefined,
            override_requeued_by: undefined,
          });
          const restored = dbService.getTweet('collision-1', 'destination.example');
          const restoredAt = parseSqliteUtcTimestampMs(restored?.created_at);
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            createdAtPreserved: restored?.created_at === original?.created_at,
            restoredStaleVersusEnqueue:
              typeof restoredAt === 'number' && Number.isFinite(restoredAt) && restoredAt < enqueuedAt,
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      createdAtPreserved: true,
      restoredStaleVersusEnqueue: true,
    });
  } finally {
    temporary.cleanup();
  }
});
