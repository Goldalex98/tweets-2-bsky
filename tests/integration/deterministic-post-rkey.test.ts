import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('a repeated chunk delivery sends the same TID key and adopts the landed post', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'post-rkey.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      import { mock } from 'bun:test';
      mock.module('dotenv/config', () => ({}));
      const { BskyAgent } = await import('@atproto/api');
      const { postWithDeterministicRkey } = await import(${moduleUrl('index.ts')});
      const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' +
        Buffer.from(JSON.stringify({ sub: 'did:plc:redacted', exp: 9999999999 })).toString('base64url') + '.redacted';
      const cid = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
      const stored = new Map();
      const createKeys = [];
      const fetchImpl = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        const lexicon = url.pathname.split('/').pop();
        if (lexicon === 'com.atproto.server.createSession') {
          return Response.json({ did: 'did:plc:redacted', handle: 'redacted.example', accessJwt: token, refreshJwt: token });
        }
        if (lexicon === 'com.atproto.repo.createRecord') {
          const body = await request.json();
          createKeys.push(body.rkey);
          if (stored.has(body.rkey)) {
            return Response.json({ error: 'InvalidRequest', message: 'Record already exists' }, { status: 400 });
          }
          stored.set(body.rkey, body.record);
          return Response.json({ uri: 'at://did:plc:redacted/app.bsky.feed.post/' + body.rkey, cid });
        }
        if (lexicon === 'com.atproto.repo.getRecord') {
          const value = stored.get(url.searchParams.get('rkey'));
          if (!value) return Response.json({ error: 'RecordNotFound', message: 'Could not locate record' }, { status: 400 });
          return Response.json({ uri: 'at://did:plc:redacted/app.bsky.feed.post/' + url.searchParams.get('rkey'), cid, value });
        }
        throw new Error('Unexpected fixture lexicon ' + lexicon);
      };
      const agent = new BskyAgent({ service: 'https://bsky.social', fetch: fetchImpl });
      await agent.login({ identifier: 'redacted.example', password: '<redacted-app-password>' });
      const mapping = { id: 'destination', bskyIdentifier: 'redacted.example', bskyDid: 'did:plc:redacted' };
      const record = { text: 'Redacted post', createdAt: '2026-10-03T12:00:00.000Z' };
      const first = await postWithDeterministicRkey(agent, mapping, 'destination', '1840000000000000000', 0, { ...record });
      const retry = await postWithDeterministicRkey(agent, mapping, 'destination', '1840000000000000000', 0, { ...record });
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ first, retry, createKeys, records: stored.size }));
      process.exit(0);
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result.records).toBe(1);
    expect(result.createKeys).toHaveLength(2);
    expect(result.createKeys[0]).toBe(result.createKeys[1]);
    expect(result.createKeys[0]).toMatch(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(result.retry).toEqual(result.first);
  } finally {
    temporary.cleanup();
  }
}, 30000);
