import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.DEPLOYMENT_BASE_URL;
const storageState = process.env.DEPLOYMENT_STORAGE_STATE;
const expectedVersion = process.env.DEPLOYMENT_EXPECTED_VERSION;
if (!baseURL || !storageState || !expectedVersion) {
  throw new Error('Deployment UI checks require DEPLOYMENT_BASE_URL, DEPLOYMENT_STORAGE_STATE, and DEPLOYMENT_EXPECTED_VERSION.');
}
const target = new URL(baseURL);
if (target.protocol !== 'https:' || target.pathname !== '/' || target.username || target.password || target.search || target.hash) {
  throw new Error('DEPLOYMENT_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.');
}
if (!existsSync(storageState)) throw new Error('The supplied deployment session file does not exist.');

export default defineConfig({
  testDir: './tests/e2e-production',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: 'line',
  outputDir: 'test-results/production-ui',
  use: {
    baseURL,
    storageState,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
