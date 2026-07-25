import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

test('database imports honor a preconfigured temporary data directory', async () => {
  const temporary = createTemporaryDataDir();

  try {
    const storageModuleUrl = new URL('../../src/storage-paths.ts', import.meta.url).href;
    const dbModuleUrl = new URL('../../src/db.ts', import.meta.url).href;
    const script = `
      const storage = await import(${JSON.stringify(storageModuleUrl)});
      await import(${JSON.stringify(dbModuleUrl)});
      console.log(JSON.stringify({
        dataDir: storage.DATA_DIR,
        configFile: storage.ACTIVE_CONFIG_FILE,
        dbPath: storage.DB_PATH,
        external: storage.USING_EXTERNAL_DATA_DIR
      }));
    `;

    const subprocess = Bun.spawn([process.execPath, '--eval', script], {
      env: temporary.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    const paths = JSON.parse(stdout.trim()) as {
      dataDir: string;
      configFile: string;
      dbPath: string;
      external: boolean;
    };

    expect(path.resolve(paths.dataDir)).toBe(path.resolve(temporary.path));
    expect(path.resolve(paths.configFile)).toBe(path.join(path.resolve(temporary.path), 'config.json'));
    expect(path.resolve(paths.dbPath)).toBe(path.join(path.resolve(temporary.path), 'database.sqlite'));
    expect(paths.external).toBe(true);
    expect(fs.existsSync(paths.dbPath)).toBe(true);
  } finally {
    temporary.cleanup();
  }
});
