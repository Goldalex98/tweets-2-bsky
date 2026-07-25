import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('backup snapshots WAL data and restore validation is no-write and fail-safe', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'backup-result.json');
  const restartResultPath = path.join(temporary.path, 'restart-result.json');
  const backupModuleUrl = new URL('../../src/backup-service.ts', import.meta.url).href;
  const configModuleUrl = new URL('../../src/config-manager.ts', import.meta.url).href;
  const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const path = await import('node:path');
          const { Database } = await import('bun:sqlite');
          const backup = await import(${JSON.stringify(backupModuleUrl)});
          const configManager = await import(${JSON.stringify(configModuleUrl)});
          const { dbService } = await import(${JSON.stringify(dbModuleUrl)});
          const config = configManager.getConfig();
          const now = new Date().toISOString();
          config.users.push({
            id: 'admin-id',
            username: 'admin',
            passwordHash: 'hashed-password',
            tokenVersion: 0,
            role: 'admin',
            permissions: {
              viewAllMappings: true,
              manageOwnMappings: true,
              manageAllMappings: true,
              manageGroups: true,
              queueBackfills: true,
              runNow: true,
            },
            createdAt: now,
            updatedAt: now,
          });
          configManager.saveConfig(config);
          configManager.addMapping({
            twitterUsernames: ['source'],
            bskyIdentifier: 'destination.example',
            bskyPassword: 'full-backup-secret',
            createdByUserId: 'admin-id',
          });
          dbService.saveTweet({
            twitter_id: 'wal-row',
            twitter_username: 'source',
            bsky_identifier: 'destination.example',
            status: 'migrated',
          });
          const redacted = backup.createBackupBundle('redacted');
          const full = backup.createBackupBundle('full');
          dbService.saveTweet({
            twitter_id: 'post-backup-row',
            twitter_username: 'source',
            bsky_identifier: 'destination.example',
            status: 'migrated',
          });
          const redactedValidation = backup.validateBackupBundle(redacted);
          const fullValidation = backup.validateBackupBundle(full);
          const rawBundle = JSON.parse(redacted.toString());
          const databaseEntry = rawBundle.files.find((entry) => entry.path === 'database.sqlite');
          const snapshotPath = path.join(${JSON.stringify(temporary.path)}, 'snapshot.sqlite');
          fs.writeFileSync(snapshotPath, Buffer.from(databaseEntry.data, 'base64'));
          const snapshotDb = new Database(snapshotPath, { readonly: true });
          const walRow = snapshotDb.query("SELECT twitter_id FROM processed_tweets WHERE twitter_id = 'wal-row'").get();
          snapshotDb.close();

          const beforeInvalid = fs.readFileSync(path.join(${JSON.stringify(temporary.path)}, 'config.json'), 'utf8');
          const tampered = JSON.parse(redacted.toString());
          tampered.files[0].data = tampered.files[0].data.slice(0, -4) + 'AAAA';
          let tamperError = '';
          try { backup.validateBackupBundle(Buffer.from(JSON.stringify(tampered))); } catch (error) { tamperError = error.message; }
          const traversal = JSON.parse(redacted.toString());
          traversal.files[0].path = '../config.json';
          let traversalError = '';
          try { backup.validateBackupBundle(Buffer.from(JSON.stringify(traversal))); } catch (error) { traversalError = error.message; }
          let sizeError = '';
          try { backup.validateBackupBundle(redacted, 10); } catch (error) { sizeError = error.message; }
          const afterInvalid = fs.readFileSync(path.join(${JSON.stringify(temporary.path)}, 'config.json'), 'utf8');

          const applyReport = backup.applyRestoreBundle(redacted, { confirmation: 'RESTORE' });
          const restored = configManager.getConfig();
          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            redactedReport: redactedValidation.report,
            fullReport: fullValidation.report,
            fullBundleLeaksPlaintext: full.toString().includes('full-backup-secret'),
            walRow: walRow?.twitter_id,
            tamperError,
            traversalError,
            sizeError,
            invalidNoWrite: beforeInvalid === afterInvalid,
            userPreserved: restored.users.some((user) => user.id === 'admin-id'),
            secretPreserved: restored.mappings[0]?.bskyPassword === 'full-backup-secret',
            pendingDatabaseExists: fs.existsSync(applyReport.pendingDatabase),
            preRestoreBackupExists: fs.existsSync(applyReport.preRestoreBackup),
          }));
        `,
      ],
      {
        env: { ...temporary.env, CONFIG_ENCRYPTION_KEY: '33'.repeat(32), NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const restart = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const fs = await import('node:fs');
          const { dbService } = await import(${JSON.stringify(dbModuleUrl)});
          await Bun.write(${JSON.stringify(restartResultPath)}, JSON.stringify({
            restoredRow: dbService.getTweet('wal-row', 'destination.example')?.twitter_id,
            postBackupRow: dbService.getTweet('post-backup-row', 'destination.example')?.twitter_id,
            pendingExists: fs.existsSync(${JSON.stringify(path.join(temporary.path, 'database.restore-pending.sqlite'))}),
            previousDatabaseRetained: fs.readdirSync(${JSON.stringify(temporary.path)})
              .some((name) => name.startsWith('database.sqlite.pre-restore-') && name.endsWith('.bak')),
          }));
        `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [restartExitCode, restartStderr] = await Promise.all([
      restart.exited,
      new Response(restart.stderr).text(),
    ]);
    expect(restartExitCode, restartStderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const restartResult = JSON.parse(fs.readFileSync(restartResultPath, 'utf8'));
    expect(result.redactedReport).toMatchObject({
      valid: true,
      mode: 'redacted',
      preservesCurrentUsersAndSecrets: true,
    });
    expect(result.fullReport).toMatchObject({
      valid: true,
      mode: 'full',
      encryptionRequired: true,
      preservesCurrentUsersAndSecrets: false,
    });
    expect(result.fullBundleLeaksPlaintext).toBe(false);
    expect(result.walRow).toBe('wal-row');
    expect(result.tamperError).toContain('checksum or size');
    expect(result.traversalError).toContain('unsafe');
    expect(result.sizeError).toContain('size limit');
    expect(result.invalidNoWrite).toBe(true);
    expect(result.userPreserved).toBe(true);
    expect(result.secretPreserved).toBe(true);
    expect(result.pendingDatabaseExists).toBe(true);
    expect(result.preRestoreBackupExists).toBe(true);
    expect(restartResult).toEqual({
      restoredRow: 'wal-row',
      pendingExists: false,
      previousDatabaseRetained: true,
    });
  } finally {
    temporary.cleanup();
  }
});
