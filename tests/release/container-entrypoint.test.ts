import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entrypoint = path.resolve(import.meta.dir, '../../docker/entrypoint.sh');
const run = async (args: string[], env: Record<string, string>) => {
  const child = Bun.spawn(['sh', entrypoint, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr };
};

test('the image runs the app through the privilege-dropping entrypoint', () => {
  const dockerfile = fs.readFileSync(path.resolve(import.meta.dir, '../../Dockerfile'), 'utf8');
  expect(dockerfile).toContain('COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/tweets2bsky-entrypoint');
  expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tweets2bsky-entrypoint"]');
  expect(dockerfile).toContain('chown 1000:1000 /app/data');
});

test.skipIf(process.platform === 'win32')(
  'the entrypoint is valid sh and passes the command and its exit code through',
  async () => {
    const syntax = Bun.spawnSync(['sh', '-n', entrypoint]);
    expect(syntax.exitCode, syntax.stderr.toString()).toBe(0);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-entrypoint-'));
    try {
      const result = await run(['sh', '-c', 'echo "ran as $(id -u)"; exit 7'], { TWEETS2BSKY_DATA_DIR: dataDir });
      expect(result.code).toBe(7);
      // Root drops to uid 1000; any other user keeps its own uid.
      const expected = process.getuid?.() === 0 ? 1000 : process.getuid?.();
      expect(result.stdout.split('\n').at(-1)).toBe(`ran as ${expected}`);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
