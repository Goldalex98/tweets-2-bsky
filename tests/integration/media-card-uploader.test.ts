import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

for (const [scenario, description] of [
  ['ordinary', 'ordinary images keep their existing byte ceiling and optimization behavior'],
  ['cards', 'external and quoted cards keep their text when thumbnail validation or upload fails'],
] as const) {
  test(description, async () => {
    const temporary = createTemporaryDataDir();
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL('../fixtures/media-card-uploader.ts', import.meta.url)), scenario],
      { cwd: temporary.path, env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stdout).toContain('Media fixture assertions passed');
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
      temporary.cleanup();
    }
  }, 20_000);
}
