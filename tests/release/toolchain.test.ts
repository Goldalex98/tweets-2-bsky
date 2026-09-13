import { expect, test } from 'bun:test';

test('release is gated, plugins support the pinned Node, and Conventional Commits keep their release semantics', async () => {
  const child = Bun.spawn([process.execPath, 'scripts/release-toolchain-preflight.mjs'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
});
