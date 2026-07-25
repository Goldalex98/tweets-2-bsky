import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const configManagerUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
const fixtureUrl = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

for (const scenario of [
  {
    name: 'legacy v0 one-to-one',
    fixture: 'config-v0-single-source.json',
    expectedSources: 1,
    expectedBackups: [
      '.pre-v2-backup',
      '.pre-v3-backup',
      '.pre-v4-backup',
      '.pre-v5-backup',
      '.pre-v6-backup',
      '.pre-v7-backup',
    ],
  },
  {
    name: 'legacy aggregate',
    fixture: 'config-v1-multi-source.json',
    expectedSources: 2,
    expectedBackups: [
      '.pre-v2-backup',
      '.pre-v3-backup',
      '.pre-v4-backup',
      '.pre-v5-backup',
      '.pre-v6-backup',
      '.pre-v7-backup',
    ],
  },
  {
    name: 'legacy v6',
    fixture: 'config-v6-current.json',
    expectedSources: 0,
    expectedBackups: ['.pre-v3-backup', '.pre-v7-backup'],
  },
  {
    name: 'current v7',
    fixture: 'config-v7-current.json',
    expectedSources: 0,
    expectedBackups: [],
  },
]) {
  test(`copied persistent volume upgrades ${scenario.name} twice and retains rollback artifacts`, async () => {
    const volume = createTemporaryDataDir();
    const configPath = path.join(volume.path, 'config.json');
    fs.copyFileSync(fixtureUrl(scenario.fixture), configPath);
    try {
      const expectedBackupsJson = JSON.stringify(scenario.expectedBackups);
      const allBackupSuffixesJson = JSON.stringify([
        '.pre-v2-backup',
        '.pre-v3-backup',
        '.pre-v4-backup',
        '.pre-v5-backup',
        '.pre-v6-backup',
        '.pre-v7-backup',
      ]);
      const subprocess = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
            const fs = await import('node:fs');
            const manager = await import(${JSON.stringify(configManagerUrl)});
            const first = manager.getConfig();
            const firstBytes = fs.readFileSync(${JSON.stringify(configPath)}, 'utf8');
            const second = manager.getConfig();
            const secondBytes = fs.readFileSync(${JSON.stringify(configPath)}, 'utf8');
            if (firstBytes !== secondBytes) throw new Error('Second migration changed persisted bytes.');
            if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Second migration changed config.');
            if (first.schemaVersion !== 7) throw new Error('Expected current schema v7.');
            if (first.sources.length !== ${scenario.expectedSources}) throw new Error('Unexpected source count.');
            const expected = new Set(${expectedBackupsJson});
            for (const suffix of ${allBackupSuffixesJson}) {
              const exists = fs.existsSync(${JSON.stringify(configPath)} + suffix);
              if (expected.has(suffix) && !exists) throw new Error('Missing rollback artifact ' + suffix);
              if (!expected.has(suffix) && exists) throw new Error('Unexpected rollback artifact ' + suffix);
            }
          `,
        ],
        { env: { ...volume.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
    } finally {
      volume.cleanup();
    }
  });
}

test('fresh copied volume supports one-to-one, aggregate, and source fanout', async () => {
  const volume = createTemporaryDataDir();
  const resultPath = path.join(volume.path, 'fresh-result.json');
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const manager = await import(${JSON.stringify(configManagerUrl)});
          manager.addMapping({
            twitterUsernames: ['one'],
            bskyIdentifier: 'one.bsky.social',
            bskyPassword: '<redacted-app-password>',
          });
          manager.addMapping({
            twitterUsernames: ['alpha', 'beta'],
            bskyIdentifier: 'aggregate.bsky.social',
            bskyPassword: '<redacted-app-password>',
          });
          manager.addMapping({
            twitterUsernames: ['one'],
            bskyIdentifier: 'fanout.bsky.social',
            bskyPassword: '<redacted-app-password>',
          });
          const first = manager.getConfig();
          const firstBytes = (await Bun.file(${JSON.stringify(path.join(volume.path, 'config.json'))}).text());
          const second = manager.getConfig();
          const secondBytes = (await Bun.file(${JSON.stringify(path.join(volume.path, 'config.json'))}).text());
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            schemaVersion: first.schemaVersion,
            sourceCounts: first.mappings.map((mapping) => mapping.twitterUsernames.length).sort(),
            oneSourceRouteCount: first.routes.filter((route) => {
              const source = first.sources.find((candidate) => candidate.id === route.sourceId);
              return source?.username === 'one';
            }).length,
            idempotent: firstBytes === secondBytes && JSON.stringify(first) === JSON.stringify(second),
          }));
        `,
      ],
      { env: { ...volume.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result).toEqual({
      schemaVersion: 7,
      sourceCounts: [1, 1, 2],
      oneSourceRouteCount: 2,
      idempotent: true,
    });
  } finally {
    volume.cleanup();
  }
});

test('duplicate canonical destinations fail closed without overwriting the copied volume', async () => {
  const volume = createTemporaryDataDir();
  const configPath = path.join(volume.path, 'config.json');
  const duplicate = `${JSON.stringify({
    schemaVersion: 6,
    revision: 3,
    updatedAt: '2026-07-24T20:00:00.000Z',
    twitter: { authToken: '', ct0: '' },
    sources: [],
    routes: [],
    destinations: [
      {
        id: 'one',
        enabled: true,
        bskyIdentifier: 'same.bsky.social',
        bskyPassword: '<redacted>',
        bskyServiceUrl: 'https://bsky.social',
      },
      {
        id: 'two',
        enabled: true,
        bskyIdentifier: 'same.bsky.social',
        bskyPassword: '<redacted>',
        bskyServiceUrl: 'https://bsky.social',
      },
    ],
  })}\n`;
  fs.writeFileSync(configPath, duplicate);
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const manager = await import(${JSON.stringify(configManagerUrl)});
          const config = manager.getConfig();
          let blocked = false;
          try { manager.saveConfig(config); } catch { blocked = true; }
          if (!blocked) throw new Error('Invalid duplicate config did not block writes.');
          if (fs.readFileSync(${JSON.stringify(configPath)}, 'utf8') !== ${JSON.stringify(duplicate)}) {
            throw new Error('Invalid copied volume was overwritten.');
          }
        `,
      ],
      { env: { ...volume.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
  } finally {
    volume.cleanup();
  }
});

for (const storage of [
  { name: 'plaintext', encryptionKey: undefined, leaksPlaintext: true },
  { name: 'encrypted', encryptionKey: '55'.repeat(32), leaksPlaintext: false },
]) {
  test(`${storage.name} copied config survives a clean process restart`, async () => {
    const volume = createTemporaryDataDir();
    const resultPath = path.join(volume.path, 'storage-result.json');
    const env = {
      ...volume.env,
      NODE_ENV: 'test',
      ...(storage.encryptionKey ? { CONFIG_ENCRYPTION_KEY: storage.encryptionKey } : {}),
    };
    try {
      const writer = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
            const fs = await import('node:fs');
            const manager = await import(${JSON.stringify(configManagerUrl)});
            manager.addMapping({
              twitterUsernames: ['storage-source'],
              bskyIdentifier: 'storage.bsky.social',
              bskyPassword: 'fixture-secret-value',
            });
            const bytes = fs.readFileSync(${JSON.stringify(path.join(volume.path, 'config.json'))}, 'utf8');
            await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
              leaksPlaintext: bytes.includes('fixture-secret-value'),
            }));
          `,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      );
      const [writerExit, writerStderr] = await Promise.all([writer.exited, new Response(writer.stderr).text()]);
      expect(writerExit, writerStderr).toBe(0);

      const reader = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `
            const manager = await import(${JSON.stringify(configManagerUrl)});
            const config = manager.getConfig();
            if (config.mappings[0]?.bskyPassword !== 'fixture-secret-value') {
              throw new Error('Stored secret did not survive restart.');
            }
          `,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      );
      const [readerExit, readerStderr] = await Promise.all([reader.exited, new Response(reader.stderr).text()]);
      expect(readerExit, readerStderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(resultPath, 'utf8')).leaksPlaintext).toBe(storage.leaksPlaintext);
    } finally {
      volume.cleanup();
    }
  });
}
