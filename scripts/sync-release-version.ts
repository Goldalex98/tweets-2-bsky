/**
 * Keep the README "Current release: app `X.Y.Z`" line aligned with the app version.
 * Invoked by semantic-release (@semantic-release/exec) during prepare.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: bun scripts/sync-release-version.ts <semver>');
  process.exit(1);
}

const readmePath = path.resolve(import.meta.dirname, '..', 'README.md');
const before = readFileSync(readmePath, 'utf8');
const pattern = /(Current release:\s*app\s*`)[^`]+(`)/;
if (!pattern.test(before)) {
  console.error('README.md does not contain a "Current release: app `...`" marker.');
  process.exit(1);
}

const after = before.replace(pattern, `$1${version}$2`);
if (after === before) {
  console.log(`README.md already at app \`${version}\``);
} else {
  writeFileSync(readmePath, after, 'utf8');
  console.log(`Updated README.md Current release to app \`${version}\``);
}
