import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import express from 'express';
import { applySecurityHeaders } from '../../src/http-security.js';

test.use({ launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] } });

test('video thumbnails follow the allowed CDN redirect while other image origins remain blocked', async ({ page }) => {
  const original = 'https://video.bsky.app/allowed-thumbnail';
  const redirected = 'https://video.cdn.bsky.app/thumbnail';
  const deniedOriginal = 'https://video.bsky.app/denied-thumbnail';
  const denied = 'https://unallowed.bsky.app/thumbnail';
  const app = express();
  // Exercise the production middleware itself; no copied or relaxed CSP fixture.
  app.use(applySecurityHeaders);
  app.get('/', (_request, response) => {
    response.type('html').send(`<!doctype html><html lang="en"><head><title>CSP fixture</title></head><body>
      <img alt="Allowed video thumbnail" src="${original}">
      <img alt="Denied video thumbnail" src="${deniedOriginal}">
    </body></html>`);
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture must listen on a local TCP port');
    const documentUrl = `http://127.0.0.1:${address.port}/`;
    const routed: string[] = [];
    const unexpected: string[] = [];
    const violations: { directive: string; host: string }[] = [];
    await page.exposeFunction('recordFixtureCspViolation', (directive: string, host: string) => {
      violations.push({ directive, host });
    });
    await page.addInitScript(() => {
      window.addEventListener('securitypolicyviolation', (event) => {
        const report = (
          window as Window & { recordFixtureCspViolation?: (directive: string, host: string) => Promise<void> }
        ).recordFixtureCspViolation;
        if (!report) throw new Error('CSP fixture reporting binding is unavailable');
        void report(event.effectiveDirective, new URL(event.blockedURI).hostname);
      });
    });
    const interceptionErrors: string[] = [];
    const cdp = await page.context().newCDPSession(page);
    // Fetch pauses every redirect hop; page.route only handles the initial URL.
    // DNS is also disabled for all non-loopback hosts as a network backstop.
    cdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        const { requestId, request } = event;
        const url = request.url;
        if (url === documentUrl && request.method === 'GET') return cdp.send('Fetch.continueRequest', { requestId });
        routed.push(url);
        if (url === original || url === deniedOriginal) {
          return cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 302,
            responseHeaders: [{ name: 'Location', value: url === original ? redirected : denied }],
          });
        }
        if (url === redirected) {
          return cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }],
            body: Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
            ).toString('base64'),
          });
        }
        unexpected.push(url);
        return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      })().catch((error: unknown) => interceptionErrors.push(String(error)));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const response = await page.goto(documentUrl);
    expect(response?.status()).toBe(200);
    await expect(page.getByAltText('Allowed video thumbnail')).toHaveJSProperty('naturalWidth', 1);
    await expect(page.getByAltText('Denied video thumbnail')).toHaveJSProperty('complete', true);
    await expect(page.getByAltText('Denied video thumbnail')).toHaveJSProperty('naturalWidth', 0);
    await expect.poll(() => violations).toEqual([{ directive: 'img-src', host: 'video.bsky.app' }]);
    expect(routed.sort()).toEqual([original, redirected, deniedOriginal].sort());
    // The denied redirect must be stopped by CSP before reaching routing/network.
    expect(unexpected).toEqual([]);
    expect(interceptionErrors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
