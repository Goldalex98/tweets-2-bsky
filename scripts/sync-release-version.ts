/**
 * Keep package.json version and the README "Current release: app `X.Y.Z`" line
 * aligned. Invoked by semantic-release (@semantic-release/exec) during prepare.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: bun scripts/sync-release-version.ts <semver>');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');

const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string; [key: string]: unknown };
if (pkg.version === version) {
  console.log(`package.json already at ${version}`);
} else {
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`Updated package.json version to ${version}`);
}

const readmePath = path.join(root, 'README.md');
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
