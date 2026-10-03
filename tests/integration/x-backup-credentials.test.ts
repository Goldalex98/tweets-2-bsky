import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('an X auth failure retries with a client built from the backup cookies', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'x-backup.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { mock } from 'bun:test';
      const attempts = [];
      mock.module('dotenv/config', () => ({}));
      mock.module('@the-convocation/twitter-scraper', () => ({
        Scraper: class {
          async setCookies(cookies) { this.authToken = cookies[0]; }
          async *getTweets() {
            attempts.push(this.authToken);
            if (this.authToken === 'auth_token=<redacted-primary>') {
              throw Object.assign(new Error('Response status: 401'), { status: 401 });
            }
            yield { id: '1', text: 'Redacted tweet', timeParsed: new Date(0), photos: [], videos: [], urls: [], hashtags: [], mentions: [] };
          }
        },
      }));
      globalThis.fetch = async () => { throw new Error('Unexpected fixture outbound fetch'); };
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { getDefaultConfig } = await import(${moduleUrl('config/defaults.ts')});
      const config = getDefaultConfig();
      config.twitter = {
        authToken: '<redacted-primary>', ct0: '<redacted-ct0>',
        backupAuthToken: '<redacted-backup>', backupCt0: '<redacted-backup-ct0>',
      };
      configManager.saveCanonicalConfig(config);
      const { fetchUserTweets } = await import(${moduleUrl('index.ts')});
      const tweets = await fetchUserTweets('redacted_source', 5, undefined, 'fixture', true);
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ attempts, tweets: tweets.length }));
      process.exit(0);
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toEqual({
      attempts: ['auth_token=<redacted-primary>', 'auth_token=<redacted-backup>'],
      tweets: 1,
    });
  } finally {
    temporary.cleanup();
  }
}, 30000);
