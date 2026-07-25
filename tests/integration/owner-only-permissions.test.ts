import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const OWNER_ONLY = 0o600;

test('secret-bearing files are created for the owner only', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'permissions-result.json');
  const configModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
  const backupModuleUrl = new URL('../../src/backup-service.ts', import.meta.url).href;
  const storagePathsUrl = new URL('../../src/storage-paths.ts', import.meta.url).href;
  // A legacy document forces the migration backup path in addition to a normal save.
  fs.writeFileSync(
    path.join(temporary.path, 'config.json'),
    JSON.stringify({
      schemaVersion: 1,
      twitter: { authToken: 'legacy-auth', ct0: 'legacy-ct0' },
      checkIntervalMinutes: 7,
      mappings: [
        {
          id: 'legacy-mapping',
          twitterUsernames: ['source'],
          bskyIdentifier: 'destination.example',
          bskyPassword: 'destination-password',
          enabled: true,
        },
      ],
    }),
  );
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const nodeFs = (await import('node:fs')).default;
          const writes = [];
          const chmods = [];
          const originalWrite = nodeFs.writeFileSync;
          const originalChmod = nodeFs.chmodSync;
          nodeFs.writeFileSync = (target, data, options) => {
            writes.push({ path: String(target), mode: options && options.mode });
            return originalWrite(target, data, options);
          };
          nodeFs.chmodSync = (target, mode) => {
            chmods.push({ path: String(target), mode });
            return originalChmod(target, mode);
          };

          const configManager = await import(${JSON.stringify(configModuleUrl)});
          const backup = await import(${JSON.stringify(backupModuleUrl)});
          const { enforceOwnerOnlyFileMode } = await import(${JSON.stringify(storagePathsUrl)});

          // Loading the legacy document migrates it, which writes a migration
          // backup and rewrites the live config.
          const migrated = configManager.getConfig();
          migrated.scheduler.intervalMinutes = 11;
          configManager.saveConfig(migrated);
          const report = backup.applyRestoreBundle(backup.createBackupBundle('redacted'), {
            confirmation: 'RESTORE',
          });

          // Missing files must never abort the write that produced them.
          let enforcementThrew = false;
          try {
            enforceOwnerOnlyFileMode(${JSON.stringify(path.join(temporary.path, 'does-not-exist.json'))});
          } catch {
            enforcementThrew = true;
          }

          nodeFs.writeFileSync = originalWrite;
          nodeFs.chmodSync = originalChmod;
          const observedMode = (target) => {
            try {
              return nodeFs.statSync(target).mode & 0o777;
            } catch {
              return null;
            }
          };
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            platform: process.platform,
            writes,
            chmods,
            enforcementThrew,
            preRestoreBackup: report.preRestoreBackup,
            configMode: observedMode(${JSON.stringify(path.join(temporary.path, 'config.json'))}),
            backupArtifactMode: observedMode(report.preRestoreBackup),
          }));
        `,
      ],
      { env: { ...temporary.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as {
      platform: string;
      writes: Array<{ path: string; mode?: number }>;
      chmods: Array<{ path: string; mode: number }>;
      enforcementThrew: boolean;
      configMode: number | null;
      backupArtifactMode: number | null;
    };

    const modeFor = (suffix: string) =>
      result.writes.filter((entry) => entry.path.includes(suffix)).map((entry) => entry.mode);
    expect(result.enforcementThrew).toBe(false);
    // Every artifact that can carry secrets is created restricted, so there is
    // no window where it is world-readable.
    expect(modeFor('config.json.tmp')).not.toHaveLength(0);
    for (const suffix of [
      'config.json.tmp',
      'config.json.pre-v',
      'pre-restore-',
      'database.restore-pending.sqlite.tmp',
    ]) {
      const modes = modeFor(suffix);
      expect(modes, suffix).not.toHaveLength(0);
      expect(modes.every((mode) => mode === OWNER_ONLY), suffix).toBe(true);
    }

    if (result.platform === 'win32') {
      // POSIX modes have no Windows equivalent, so the enforcement is skipped
      // there rather than failing the write.
      expect(result.chmods).toHaveLength(0);
    } else {
      expect(result.chmods.every((entry) => entry.mode === OWNER_ONLY)).toBe(true);
      expect(result.chmods.some((entry) => entry.path.endsWith('config.json'))).toBe(true);
      expect(result.configMode).toBe(OWNER_ONLY);
      expect(result.backupArtifactMode).toBe(OWNER_ONLY);
    }
  } finally {
    temporary.cleanup();
  }
});
