import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

// Runs inside a fresh validation container, with no production volume or accounts.
const database = new Database(':memory:');
try {
  database.exec('CREATE TABLE smoke (value INTEGER); INSERT INTO smoke VALUES (42)');
  assert.deepEqual(database.prepare('SELECT value FROM smoke').get(), { value: 42 });
} finally {
  database.close();
}

const encoded = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } })
  .resize(16, 16)
  .png()
  .toBuffer();
assert.equal((await sharp(encoded).metadata()).width, 16);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  timeout: 30_000,
});
const browserProcess = browser.process();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 240 });
  await page.setContent('<!doctype html><title>Image smoke</title><h1>Rendered successfully</h1>');
  assert.equal(await page.title(), 'Image smoke');
  const screenshot = await page.screenshot({ type: 'png' });
  assert.equal((await sharp(screenshot).metadata()).width, 320);
} finally {
  await browser.close();
}
assert.ok(browserProcess && (browserProcess.exitCode !== null || browserProcess.signalCode !== null));
console.log(`Image native modules and Chromium render/cleanup passed on ${process.platform}/${process.arch}.`);
