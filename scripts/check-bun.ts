import { readFileSync } from 'node:fs';

const version = Bun.version;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  packageManager: string;
};
const expected = manifest.packageManager.replace(/^bun@/, '');

if (version !== expected) {
  console.error(`Bun ${expected} is required by package.json. Current version: ${version || 'unknown'}`);
  process.exit(1);
}

console.log(`Bun ${version} ready`);
