import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { CURRENT_CONFIG_SCHEMA_VERSION } from '../../src/config/schemas.js';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const configManagerModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;

async function runIsolatedConfigScript(
  env: NodeJS.ProcessEnv,
  scriptBody: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
        import fs from 'node:fs';
        import path from 'node:path';
        const configManager = await import(${JSON.stringify(configManagerModuleUrl)});
        ${scriptBody}
      `,
    ],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test('first legacy load writes versioned backups and the second load is byte stable', async () => {
  const temporary = createTemporaryDataDir();
  const configPath = path.join(temporary.path, 'config.json');
  const resultPath = path.join(temporary.path, 'result.json');
  const legacy = fs.readFileSync(new URL('../fixtures/config-v0-single-source.json', import.meta.url), 'utf8');
  fs.writeFileSync(configPath, legacy);

  try {
    const result = await runIsolatedConfigScript(
      temporary.env,
      `
        const first = configManager.getConfig();
        const afterFirst = fs.readFileSync(${JSON.stringify(configPath)}, 'utf8');
        const preV2Backup = fs.readFileSync(
          ${JSON.stringify(`${configPath}.pre-v2-backup`)},
          'utf8',
        );
        const preV3Backup = fs.readFileSync(
          ${JSON.stringify(`${configPath}.pre-v3-backup`)},
          'utf8',
        );
        const preV4Backup = fs.readFileSync(
          ${JSON.stringify(`${configPath}.pre-v4-backup`)},
          'utf8',
        );
        const preV5Backup = fs.readFileSync(
          ${JSON.stringify(`${configPath}.pre-v5-backup`)},
          'utf8',
        );
        const preV8Backup = fs.readFileSync(
          ${JSON.stringify(`${configPath}.pre-v8-backup`)},
          'utf8',
        );
        const second = configManager.getConfig();
        const afterSecond = fs.readFileSync(${JSON.stringify(configPath)}, 'utf8');
        fs.writeFileSync(
          ${JSON.stringify(resultPath)},
          JSON.stringify({
            first,
            second,
            firstMappingPassword: first.mappings[0]?.bskyPassword,
            afterFirst,
            afterSecond,
            preV2Backup,
            preV3Backup,
            preV4Backup,
            preV5Backup,
            preV8Backup,
          }),
        );
      `,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const stored = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      first: { schemaVersion: number };
      second: unknown;
      firstMappingPassword?: string;
      afterFirst: string;
      afterSecond: string;
      preV2Backup: string;
      preV3Backup: string;
      preV4Backup: string;
      preV5Backup: string;
      preV8Backup: string;
    };
    expect(stored.preV2Backup).toBe(legacy);
    expect(stored.preV3Backup).toBe(legacy);
    expect(stored.preV4Backup).toBe(legacy);
    expect(stored.preV5Backup).toBe(legacy);
    expect(stored.preV8Backup).toBe(legacy);
    expect(stored.afterSecond).toBe(stored.afterFirst);
    expect(stored.second).toEqual(stored.first);
    expect(stored.first.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(stored.firstMappingPassword).toBe('<redacted>');
    expect(JSON.parse(stored.afterFirst).mappings).toBeUndefined();
  } finally {
    temporary.cleanup();
  }
});

test('failed migration leaves the active file untouched and blocks later saves', async () => {
  const temporary = createTemporaryDataDir();
  const configPath = path.join(temporary.path, 'config.json');
  const resultPath = path.join(temporary.path, 'result.json');
  const unsupported = '{"schemaVersion":999,"mappings":[],"sentinel":"do-not-overwrite"}\n';
  fs.writeFileSync(configPath, unsupported);

  try {
    const result = await runIsolatedConfigScript(
      temporary.env,
      `
        const config = configManager.getConfig();
        let saveError = '';
        try {
          configManager.saveConfig(config);
        } catch (error) {
          saveError = error instanceof Error ? error.message : String(error);
        }
        fs.writeFileSync(
          ${JSON.stringify(resultPath)},
          JSON.stringify({
            active: fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'),
            hasPreV2Backup: fs.existsSync(${JSON.stringify(`${configPath}.pre-v2-backup`)}),
            saveError,
          }),
        );
      `,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const stored = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      active: string;
      hasPreV2Backup: boolean;
      saveError: string;
    };
    expect(stored.active).toBe(unsupported);
    expect(stored.hasPreV2Backup).toBe(false);
    expect(stored.saveError).toContain('Refusing to save config');
  } finally {
    temporary.cleanup();
  }
});

test('an unreadable main file recovers from backup without replacing that backup', async () => {
  const temporary = createTemporaryDataDir();
  const configPath = path.join(temporary.path, 'config.json');
  const backupPath = `${configPath}.bak`;
  const resultPath = path.join(temporary.path, 'result.json');
  const backup = `${JSON.stringify(
    {
      schemaVersion: 2,
      twitter: { authToken: 'backup-auth', ct0: 'backup-ct0' },
      scheduler: { enabled: true, intervalMinutes: 9, runOnStartup: false },
      mappings: [
        {
          id: 'recovered',
          twitterUsernames: ['source'],
          bskyIdentifier: 'recovered.example',
          bskyPassword: 'backup-bsky-password',
          enabled: true,
        },
      ],
      groups: [],
      users: [],
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(configPath, '{not valid json');
  fs.writeFileSync(backupPath, backup);

  try {
    const result = await runIsolatedConfigScript(
      temporary.env,
      `
        const config = configManager.getConfig();
        fs.writeFileSync(
          ${JSON.stringify(resultPath)},
          JSON.stringify({
            config,
            mappingPassword: config.mappings[0]?.bskyPassword,
            active: fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'),
            backup: fs.readFileSync(${JSON.stringify(backupPath)}, 'utf8'),
          }),
        );
      `,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const stored = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      config: {
        schemaVersion: number;
        twitter: { authToken: string };
        scheduler: { intervalMinutes: number };
      };
      mappingPassword?: string;
      active: string;
      backup: string;
    };
    expect(stored.backup).toBe(backup);
    const active = JSON.parse(stored.active) as Record<string, unknown>;
    expect(active.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(active.mappings).toBeUndefined();
    expect(stored.config.twitter.authToken).toBe('backup-auth');
    expect(stored.config.scheduler.intervalMinutes).toBe(9);
    expect(stored.mappingPassword).toBe('backup-bsky-password');
  } finally {
    temporary.cleanup();
  }
});

test('compatibility mapping mutations persist only canonical v3 entities', async () => {
  const temporary = createTemporaryDataDir();
  const configPath = path.join(temporary.path, 'config.json');
  const resultPath = path.join(temporary.path, 'result.json');
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      schemaVersion: 2,
      twitter: { authToken: 'auth', ct0: 'ct0' },
      scheduler: { enabled: true, intervalMinutes: 5, runOnStartup: false },
      groups: [],
      users: [],
      mappings: [
        {
          id: 'destination-1',
          twitterUsernames: ['source_one'],
          bskyIdentifier: 'destination.example',
          bskyPassword: 'password',
          enabled: true,
        },
      ],
    })}\n`,
  );

  try {
    const result = await runIsolatedConfigScript(
      temporary.env,
      `
        const config = configManager.getConfig();
        config.mappings[0].twitterUsernames.push('source_two');
        configManager.saveConfig(config);
        const stored = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(stored));
      `,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const stored = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      schemaVersion: number;
      sources: Array<{ username: string }>;
      destinations: unknown[];
      routes: unknown[];
      mappings?: unknown[];
    };
    expect(stored.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(stored.sources.map((source) => source.username).sort()).toEqual(['source_one', 'source_two']);
    expect(stored.destinations).toHaveLength(1);
    expect(stored.routes).toHaveLength(2);
    expect(stored.mappings).toBeUndefined();
  } finally {
    temporary.cleanup();
  }
});
