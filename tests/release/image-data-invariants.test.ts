import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureConfigIdentity, captureDatabase, verifyDatabase } from '../../scripts/image-data-invariants.js';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('pre-upgrade row fingerprints allow additive schema but detect loss and policy changes without leaking data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-data-invariant-'));
  const filename = path.join(directory, 'fixture.sqlite');
  const database = new Database(filename);
  try {
    database.exec(`CREATE TABLE post_queue (id TEXT PRIMARY KEY, policy_snapshot TEXT, attempts INTEGER);
      INSERT INTO post_queue VALUES ('fixture', 'private-fixture-policy', 2);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (7);`);
    const expected = captureDatabase(filename);
    database.exec('ALTER TABLE post_queue ADD COLUMN queue_id TEXT; INSERT INTO schema_migrations VALUES (8);');
    expect(() => verifyDatabase(filename, expected)).not.toThrow();
    database.exec('UPDATE post_queue SET attempts = 0');
    expect(() => verifyDatabase(filename, expected)).toThrow(
      'Pre-upgrade row preservation failed for post_queue; values withheld',
    );
    database.exec('DELETE FROM post_queue');
    expect(() => verifyDatabase(filename, expected)).toThrow('values withheld');
    expect(JSON.stringify(expected)).not.toContain('private-fixture-policy');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('copied config fingerprints detect changes to account credentials and destination storage identities', () => {
  const config = {
    schemaVersion: 8,
    sources: [],
    routes: [],
    destinations: [{ id: 'destination', storageKey: 'original', enabled: true }],
    blueskyAccounts: [{ id: 'account', loginIdentifier: 'fixture.example', appPassword: '<redacted>' }],
  };
  const baseline = captureConfigIdentity(config);
  const changed = structuredClone(config);
  changed.destinations[0].storageKey = 'changed';
  expect(captureConfigIdentity(changed).digest).not.toBe(baseline.digest);
  changed.destinations[0].storageKey = 'original';
  changed.blueskyAccounts[0].appPassword = '<changed-redacted>';
  expect(captureConfigIdentity(changed).digest).not.toBe(baseline.digest);
  expect(JSON.stringify(baseline)).not.toContain('redacted');
});

test('populated v6 identity survives real account extraction and detects original identity or state changes', async () => {
  const temporary = createTemporaryDataDir();
  try {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const fs = await import('node:fs');
      const { captureConfigIdentity } = await import(${JSON.stringify(new URL('../../scripts/image-data-invariants.ts', import.meta.url).href)});
      const { migrateConfig } = await import(${JSON.stringify(new URL('../../src/config/migrations.ts', import.meta.url).href)});
      const fixture = JSON.parse(fs.readFileSync(new URL(${JSON.stringify(new URL('../fixtures/config-v6-populated.json', import.meta.url).href)}), 'utf8'));
      const before = captureConfigIdentity(fixture);
      const migrated = migrateConfig(fixture);
      if (before.shape !== 'destinations' || !migrated.destinations[0].bskyAccountId || migrated.blueskyAccounts.length !== 1)
        throw new Error('Populated fixture must exercise account extraction');
      if (captureConfigIdentity(migrated, before.shape).digest !== before.digest) throw new Error('Account extraction changed original identity');
      for (const change of [
        (value) => { value.destinations[0].storageKey = 'changed'; },
        (value) => { value.destinations[0].enabled = true; },
        (value) => { value.routes[0].enabled = true; },
        (value) => { value.sources[0].id = 'changed'; },
        (value) => { value.blueskyAccounts[0].appPassword = '<changed-redacted>'; }
      ]) {
        const changed = structuredClone(migrated); change(changed);
        if (captureConfigIdentity(changed, before.shape).digest === before.digest) throw new Error('Lost identity/state change');
      }
      const legacy = { mappings: [{ id: 'legacy-disabled', twitterUsername: 'fixture', bskyIdentifier: 'legacy.example', bskyPassword: '<redacted>', enabled: false }] };
      const legacyBefore = captureConfigIdentity(legacy);
      const legacyAfter = migrateConfig(legacy);
      if (captureConfigIdentity(legacyAfter, legacyBefore.shape).digest !== legacyBefore.digest) throw new Error('Legacy disabled state migration failed');
      legacyAfter.mappings[0].enabled = true;
      if (captureConfigIdentity(legacyAfter, legacyBefore.shape).digest === legacyBefore.digest) throw new Error('Legacy enabled change was missed');
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [status, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stderr).text()]);
    expect(status, stderr).toBe(0);
  } finally {
    temporary.cleanup();
  }
});
