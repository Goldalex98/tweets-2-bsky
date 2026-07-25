import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('restore applies the migrated document and retires credentials the bundle carried', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'restore-result.json');
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
          const crypto = await import('node:crypto');
          const { Database } = await import('bun:sqlite');
          const backup = await import(${JSON.stringify(backupModuleUrl)});
          const configManager = await import(${JSON.stringify(configModuleUrl)});
          const { dbService, ingestionCredentialService } = await import(${JSON.stringify(dbModuleUrl)});

          const configPath = path.join(${JSON.stringify(temporary.path)}, 'config.json');
          const now = new Date().toISOString();
          const config = configManager.getConfig();
          config.users.push({
            id: 'admin-id',
            username: 'admin',
            passwordHash: 'hashed-password',
            tokenVersion: 3,
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
            bskyPassword: 'destination-password',
            createdByUserId: 'admin-id',
          });
          dbService.saveTweet({
            twitter_id: 'existing-row',
            twitter_username: 'source',
            bsky_identifier: 'destination.example',
            status: 'migrated',
          });
          const sourceId = configManager.getConfig().sources[0].id;
          const issued = ingestionCredentialService.create({
            name: 'feeder',
            sourceId,
            scopes: ['ingest:posts'],
            createdBy: 'admin-id',
          });

          const bundleBytes = backup.createBackupBundle('full');
          const bundle = JSON.parse(bundleBytes.toString());
          const replaceConfig = (document) => {
            const entry = bundle.files.find((file) => file.path === 'config.json');
            const bytes = Buffer.from(JSON.stringify(document, null, 2) + '\\n');
            entry.data = bytes.toString('base64');
            entry.size = bytes.length;
            entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
          };
          // A bundle taken from an older release: the document must be migrated
          // and validated, never written through as-is.
          replaceConfig({
            schemaVersion: 1,
            twitter: { authToken: 'restored-auth', ct0: 'restored-ct0' },
            checkIntervalMinutes: 9,
            mappings: [
              {
                id: 'legacy-mapping',
                twitterUsernames: ['Legacy_Source'],
                bskyIdentifier: 'Legacy.Example',
                bskyPassword: 'legacy-password',
                enabled: true,
              },
            ],
            users: [
              {
                id: 'restored-user',
                username: 'restored',
                passwordHash: 'restored-hash',
                tokenVersion: 7,
                role: 'admin',
                permissions: {},
                createdAt: now,
                updatedAt: now,
              },
            ],
          });

          const capture = (action) => {
            try {
              action();
              return '';
            } catch (error) {
              return error.message;
            }
          };
          const withMetadata = (mutate) => {
            const copy = JSON.parse(JSON.stringify(bundle));
            const entry = copy.files.find((file) => file.path === 'metadata.json');
            const metadata = JSON.parse(Buffer.from(entry.data, 'base64').toString('utf8'));
            mutate(metadata);
            const bytes = Buffer.from(JSON.stringify(metadata, null, 2) + '\\n');
            entry.data = bytes.toString('base64');
            entry.size = bytes.length;
            entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
            return Buffer.from(JSON.stringify(copy));
          };
          const beforeApply = fs.readFileSync(configPath, 'utf8');
          const futureDatabaseSchema = capture(() =>
            backup.validateBackupBundle(withMetadata((metadata) => { metadata.databaseSchemaVersion = 9999; })),
          );
          const foreignKey = capture(() =>
            backup.validateBackupBundle(withMetadata((metadata) => { metadata.encryptionKeyFingerprint = 'ffffffffffff'; })),
          );
          const wrongFormat = capture(() =>
            backup.validateBackupBundle(withMetadata((metadata) => { metadata.createdAt = 'not-a-date'; })),
          );
          const rejectedWithoutWrite = beforeApply === fs.readFileSync(configPath, 'utf8');

          const report = backup.applyRestoreBundle(Buffer.from(JSON.stringify(bundle)), {
            confirmation: 'RESTORE',
          });
          const storedDocument = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          const restored = configManager.getConfig();

          const stagedDatabase = new Database(report.pendingDatabase, { readonly: true });
          const credentialRows = stagedDatabase
            .query('SELECT id, revoked_at FROM ingestion_credentials')
            .all();
          stagedDatabase.close();

          await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
            futureDatabaseSchema,
            foreignKey,
            wrongFormat,
            rejectedWithoutWrite,
            issuedCredentialId: issued.credential.id,
            revokedIngestionCredentials: report.revokedIngestionCredentials,
            sessionsRevoked: report.sessionsRevoked,
            credentialRows,
            storedSchemaVersion: storedDocument.schemaVersion,
            storedHasMappings: Object.prototype.hasOwnProperty.call(storedDocument, 'mappings'),
            storedHasCanonicalEntities:
              Array.isArray(storedDocument.sources) &&
              Array.isArray(storedDocument.destinations) &&
              Array.isArray(storedDocument.routes),
            storedIntervalMinutes: storedDocument.scheduler?.intervalMinutes,
            restoredDestination: restored.destinations[0]?.bskyIdentifier,
            restoredSourceUsername: restored.sources[0]?.username,
            restoredTokenVersions: restored.users.map((user) => [user.username, user.tokenVersion]),
          }));
        `,
      ],
      {
        env: { ...temporary.env, CONFIG_ENCRYPTION_KEY: '44'.repeat(32), NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

    expect(result.futureDatabaseSchema).toContain('unsupported');
    expect(result.foreignKey).toContain('different key');
    expect(result.wrongFormat).toContain('creation timestamp');
    expect(result.rejectedWithoutWrite).toBe(true);

    // Finding 5: the persisted document is the migrated, normalized one.
    expect(result.storedSchemaVersion).toBeGreaterThanOrEqual(6);
    expect(result.storedHasMappings).toBe(false);
    expect(result.storedHasCanonicalEntities).toBe(true);
    expect(result.storedIntervalMinutes).toBe(9);
    expect(result.restoredDestination).toBe('legacy.example');
    expect(result.restoredSourceUsername).toBe('legacy_source');

    // Finding 8: nothing the bundle carried can be replayed after the restore.
    expect(result.revokedIngestionCredentials).toBe(1);
    expect(result.sessionsRevoked).toBe(true);
    expect(result.credentialRows).toHaveLength(1);
    expect(result.credentialRows[0]?.id).toBe(result.issuedCredentialId);
    expect(result.credentialRows[0]?.revoked_at).toBeGreaterThan(0);
    expect(result.restoredTokenVersions).toEqual([['restored', 8]]);
  } finally {
    temporary.cleanup();
  }
});
