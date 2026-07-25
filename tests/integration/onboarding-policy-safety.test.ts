import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;

test('mapping onboarding persists aggregate-safe policy without network mutation', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const configManager = await import(${JSON.stringify(configManagerModuleUrl)});
          configManager.addMapping({
            twitterUsernames: ['first', 'second'],
            bskyIdentifier: 'aggregate.example',
            bskyPassword: '<redacted>',
            bskyServiceUrl: 'https://bsky.social'
          });
          const mapping = configManager.getConfig().mappings[0];
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(mapping));
        `,
      ],
      {
        env: temporary.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const mapping = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      postingPolicy: { attribution: { mode: string } };
      profileManagement: {
        allowProfileMutation: boolean;
        profileSync: { mode: string; sourceUsername?: string };
        pinSync: { mode: string; sourceUsername?: string };
      };
      hasBotLabel?: boolean;
    };
    expect(mapping.postingPolicy.attribution.mode).toBe('multiple-sources');
    expect(mapping.profileManagement).toMatchObject({
      allowProfileMutation: false,
      profileSync: { mode: 'off' },
      pinSync: { mode: 'off' },
    });
    expect(mapping.profileManagement.profileSync.sourceUsername).toBeUndefined();
    expect(mapping.profileManagement.pinSync.sourceUsername).toBeUndefined();
    expect(mapping.hasBotLabel).not.toBe(true);
  } finally {
    temporary.cleanup();
  }
});
