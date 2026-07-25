const version = Bun.version;
const major = Number.parseInt(version.split('.')[0] || '0', 10);

if (!Number.isFinite(major) || major < 1) {
  console.error(`Bun 1.x+ is required. Current version: ${version || 'unknown'}`);
  process.exit(1);
}

console.log(`Bun ${version} ready`);
