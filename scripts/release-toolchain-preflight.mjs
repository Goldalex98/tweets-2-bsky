import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';

// Offline release rehearsal: loads every configured plugin and checks real
// commit analysis/notes without credentials, git writes, or publication hooks.
const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const { satisfies } = require('semver');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const readWorkflow = (name) => load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const release = readWorkflow('release.yml');
const quality = readWorkflow('quality.yml');
assert.equal(release.jobs.release.needs, 'quality', 'Quality must gate semantic-release');
assert.equal(release.jobs.quality.uses, './.github/workflows/quality.yml');
assert.ok(Object.hasOwn(quality.on, 'workflow_call'));
assert.equal(quality.jobs.quality.needs, undefined, 'Quality must not depend on its callers');
const nodePin = release.jobs.release.steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with[
  'node-version'
];
const config = readJson('.releaserc.json');
assert.deepEqual(config.branches, ['main']);
assert.equal(
  config.plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === '@semantic-release/npm'),
  false,
);
for (const entry of config.plugins) {
  const name = Array.isArray(entry) ? entry[0] : entry;
  const manifest = readJson(`node_modules/${name}/package.json`);
  assert.ok(satisfies(nodePin, manifest.engines.node), `${name} does not support pinned Node ${nodePin}`);
  if (!process.versions.bun) assert.ok(satisfies(process.versions.node, manifest.engines.node));
  assert.ok(Object.keys(await import(name)).length > 0, `Could not load ${name}`);
}
const logger = { log() {}, error() {} };
const context = { cwd: root, logger };
assert.equal(
  await analyzeCommits({}, { ...context, commits: [{ hash: 'abc1234', message: 'fix: patch thumbnail upload' }] }),
  'patch',
);
assert.equal(
  await analyzeCommits({}, { ...context, commits: [{ hash: 'abc1234', message: 'feat: support longer videos' }] }),
  'minor',
);
assert.equal(
  await analyzeCommits({}, { ...context, commits: [{ hash: 'abc1234', message: 'chore: refresh tooling' }] }),
  null,
);
const notes = await generateNotes(
  {},
  {
    ...context,
    commits: [{ hash: 'abc123456789', message: 'fix: patch thumbnail upload' }],
    lastRelease: { gitTag: 'v0.0.1' },
    nextRelease: { version: '0.0.2', gitTag: 'v0.0.2' },
    options: { repositoryUrl: 'https://github.com/fixture/repository.git' },
  },
);
assert.ok(notes.includes('patch thumbnail upload'));
console.log(`Offline release toolchain rehearsal passed; pinned Node ${nodePin}, runtime ${process.versions.node}.`);
