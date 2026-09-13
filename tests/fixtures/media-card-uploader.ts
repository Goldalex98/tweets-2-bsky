import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import sharp from 'sharp';

// This fixture runs in its own process and temporary working/data directory.
// No provider credentials, servers, or live network responses are required.
globalThis.fetch = async () => {
  throw new Error('Unexpected fixture outbound fetch');
};
mock.module('dotenv/config', () => ({}));
const webhook = await import('../../src/webhook.js');
let media = Buffer.from('<html>not an image</html>');
let mediaMime = 'image/png';
let downloads = 0;
mock.module('../../src/webhook.js', () => ({
  ...webhook,
  resolveWebhookTarget: async (url: string) => {
    assert.equal(url, 'https://media.invalid/thumbnail');
    return { target: new URL(url), pinnedAddress: '192.0.2.1', family: 4 };
  },
  sendPinnedHttpsRequest: async () => {
    downloads++;
    return { status: 200, headers: { 'content-type': mediaMime }, body: media };
  },
}));
mock.module('../../src/public-http-fetch.js', () => ({
  fetchPublicHttps: async (url: string) => {
    assert.equal(url, 'https://article.invalid/post');
    return {
      status: 200,
      url,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(
        '<meta property="og:title" content="Fixture title"><meta property="og:description" content="Fixture description"><meta property="og:image" content="https://media.invalid/thumbnail">',
      ),
    };
  },
}));
const { uploadToBluesky, fetchEmbedUrlCard, buildSynthesizedQuoteCard } = await import('../../src/index.js');
const uploads: Array<{ bytes: Buffer; encoding: string }> = [];
let rejectUpload = false;
const agent = {
  async uploadBlob(bytes: Buffer, options: { encoding: string }) {
    if (rejectUpload) throw new Error('Fixture upload rejected');
    uploads.push({ bytes, encoding: options.encoding });
    return { data: { blob: { ref: 'fixture-blob', mimeType: options.encoding, size: bytes.length } } };
  },
};
// Only the uploader surface is exercised; this deliberately has no auth/post clients.
const uploader = agent as unknown as Parameters<typeof uploadToBluesky>[0];
const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#fedcba' } })
  .png()
  .toBuffer();
const paddedPng = (size: number) => Buffer.concat([png, Buffer.alloc(size - png.length)]);

if (process.argv[2] === 'ordinary') {
  for (const size of [1_500_000, 1900 * 1024]) {
    const bytes = paddedPng(size);
    await uploadToBluesky(uploader, bytes, 'image/png');
    const uploaded = uploads.at(-1);
    assert.equal(uploaded?.bytes, bytes, 'Regular images within their existing ceiling must retain their exact bytes');
    assert.equal(uploaded?.encoding, 'image/png');
  }
  await uploadToBluesky(uploader, paddedPng(1900 * 1024 + 1), 'image/png');
  const optimized = uploads.at(-1);
  assert.ok(optimized);
  assert.ok(optimized.bytes.length < 1900 * 1024);
  assert.equal(optimized.encoding, 'image/jpeg');
  const metadata = await sharp(optimized.bytes).metadata();
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 48);
  assert.equal(downloads, 0);
} else if (process.argv[2] === 'cards') {
  const quote = {
    uri: 'https://x.com/fixture/status/123',
    title: 'Quoted title',
    description: 'Quoted description',
    thumbnailUrl: 'https://media.invalid/thumbnail',
  };
  async function cards() {
    return [
      await fetchEmbedUrlCard(uploader, 'https://article.invalid/post'),
      await buildSynthesizedQuoteCard(uploader, quote, false),
    ];
  }
  function assertCardText(results: Awaited<ReturnType<typeof cards>>) {
    assert.equal(results[0]?.external.uri, 'https://article.invalid/post');
    assert.equal(results[0]?.external.title, 'Fixture title');
    assert.equal(results[0]?.external.description, 'Fixture description');
    assert.equal(results[1]?.external.uri, quote.uri);
    assert.equal(results[1]?.external.title, quote.title);
    assert.equal(results[1]?.external.description, quote.description);
    for (const card of results) assert.equal(card?.$type, 'app.bsky.embed.external');
  }
  for (const invalid of [Buffer.from('<html>not an image</html>'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
    media = invalid;
    const results = await cards();
    assertCardText(results);
    for (const card of results) assert.equal(card?.external.thumb, undefined);
  }
  assert.equal(uploads.length, 0, 'Invalid images must never reach blob upload');
  media = paddedPng(1_500_000);
  mediaMime = 'application/octet-stream';
  const results = await cards();
  assertCardText(results);
  for (const card of results) assert.ok(card?.external.thumb);
  assert.equal(uploads.length, 2);
  for (const uploaded of uploads) {
    assert.ok(uploaded.bytes.length <= 1_000_000);
    assert.equal(uploaded.encoding, 'image/jpeg');
    assert.equal((await sharp(uploaded.bytes).metadata()).format, 'jpeg');
  }
  rejectUpload = true;
  const failedUploads = await cards();
  assertCardText(failedUploads);
  for (const card of failedUploads) assert.equal(card?.external.thumb, undefined);
  const downloadCount = downloads;
  const dryRunCard = await buildSynthesizedQuoteCard(uploader, quote, true);
  assert.equal(downloads, downloadCount, 'Dry run must not download a thumbnail');
  assert.equal(dryRunCard.external.thumb, undefined);
} else throw new Error('Unknown media fixture scenario');
console.log('Media fixture assertions passed');
