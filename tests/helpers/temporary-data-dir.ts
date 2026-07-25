import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TemporaryDataDir {
  path: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function createTemporaryDataDir(): TemporaryDataDir {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets-2-bsky-test-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TWEETS2BSKY_DATA_DIR: dataDir,
  };
  env.APP_DATA_DIR = undefined;

  return {
    path: dataDir,
    env,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}
