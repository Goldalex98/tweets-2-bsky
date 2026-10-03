import { describe, expect, test } from 'bun:test';
import { XRPCError } from '@atproto/api';
import {
  type PostRecordClient,
  RkeyConflictError,
  createPostAtRkey,
  deterministicPostRkey,
  encodeTid,
} from '../../src/deterministic-rkey.js';

// Same rule as @atproto/syntax isValidTid.
const TID_REGEX = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
const decodeTimestampMicros = (tid: string) =>
  [...tid.slice(0, 11)].reduce((value, char) => value * 32n + BigInt(S32.indexOf(char)), 0n);

describe('deterministic post record keys', () => {
  test('encodes the reference TID layout', () => {
    // 2023-01-01T00:00:00Z with clock id 0, checked against @atproto/common-web TID.fromTime.
    expect(encodeTid(1672531200000000n, 0)).toBe('3jl7442uk2222');
    expect(TID_REGEX.test(encodeTid(0n, 1023))).toBe(true);
  });

  test('is stable per chunk, valid, and carries the record createdAt', () => {
    const createdAtMs = Date.parse('2026-10-03T12:00:00.000Z');
    const first = deterministicPostRkey('destination', '1840000000000000000', 0, createdAtMs);
    expect(deterministicPostRkey('destination', '1840000000000000000', 0, createdAtMs)).toBe(first);
    expect(TID_REGEX.test(first)).toBe(true);
    expect(Number(decodeTimestampMicros(first) / 1000n)).toBe(createdAtMs);
    const others = [
      deterministicPostRkey('destination', '1840000000000000000', 1, createdAtMs),
      deterministicPostRkey('other-destination', '1840000000000000000', 0, createdAtMs),
      deterministicPostRkey('destination', '1840000000000000001', 0, createdAtMs),
    ];
    expect(new Set([first, ...others]).size).toBe(4);
  });

  test('chunks that share a createdAt get distinct keys in thread order', () => {
    const createdAtMs = Date.parse('2026-10-03T12:00:00.000Z');
    const keys = [0, 1, 2, 3].map((index) => deterministicPostRkey('destination', 'post', index, createdAtMs));
    expect(new Set(keys).size).toBe(4);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('creating a post at a deterministic key', () => {
  const record = { text: 'Redacted post', createdAt: '2026-10-03T12:00:00.000Z' };
  const client = (overrides: Partial<PostRecordClient>): PostRecordClient & { gets: number } => {
    const tracked = {
      gets: 0,
      create: async () => ({ uri: 'at://did:plc:redacted/app.bsky.feed.post/new', cid: 'new-cid' }),
      get: async () => {
        tracked.gets += 1;
        return { cid: 'existing-cid', value: { text: 'Redacted post' } };
      },
      ...overrides,
    };
    return tracked;
  };

  test('creates with the given key', async () => {
    const calls: unknown[] = [];
    const posts = client({
      create: async (params) => {
        calls.push(params);
        return { uri: 'at://did:plc:redacted/app.bsky.feed.post/new', cid: 'new-cid' };
      },
    });
    expect(await createPostAtRkey(posts, 'did:plc:redacted', '3abc', record)).toEqual({
      uri: 'at://did:plc:redacted/app.bsky.feed.post/new',
      cid: 'new-cid',
    });
    expect(calls).toEqual([{ repo: 'did:plc:redacted', rkey: '3abc' }]);
  });

  test('a retry after a landed post adopts the matching record instead of posting twice', async () => {
    const posts = client({
      create: async () => {
        throw new XRPCError(400, 'InvalidRequest', 'Record already exists');
      },
    });
    expect(await createPostAtRkey(posts, 'did:plc:redacted', '3abc', record)).toEqual({
      uri: 'at://did:plc:redacted/app.bsky.feed.post/3abc',
      cid: 'existing-cid',
    });
  });

  test('a different record at the key is never adopted', async () => {
    const posts = client({
      create: async () => {
        throw new XRPCError(400, 'InvalidRequest', 'Record already exists');
      },
      get: async () => ({ cid: 'existing-cid', value: { text: 'Someone else' } }),
    });
    await expect(createPostAtRkey(posts, 'did:plc:redacted', '3abc', record)).rejects.toThrow('Refusing to adopt');
  });

  test('a same-text record replying elsewhere is not adopted, and the original error is kept as the cause', async () => {
    const failure = new XRPCError(400, 'InvalidRequest', 'Record already exists');
    const posts = client({
      create: async () => {
        throw failure;
      },
      get: async () => ({
        cid: 'existing-cid',
        value: { text: 'Redacted post', reply: { parent: { uri: 'at://did:plc:redacted/app.bsky.feed.post/other' } } },
      }),
    });
    const threaded = { ...record, reply: { parent: { uri: 'at://did:plc:redacted/app.bsky.feed.post/mine' } } };
    const rejection = await createPostAtRkey(posts, 'did:plc:redacted', '3abc', threaded).catch((error) => error);
    expect(rejection).toBeInstanceOf(RkeyConflictError);
    expect((rejection as Error).cause).toBe(failure);
  });

  test('auth and rate-limit failures are rethrown without a lookup', async () => {
    // ExpiredToken and InvalidToken arrive as 400s, the same status as a taken key.
    for (const failure of [
      new XRPCError(401, 'AuthenticationRequired'),
      new XRPCError(429, 'RateLimitExceeded'),
      new XRPCError(400, 'ExpiredToken', 'Token has expired'),
      new XRPCError(400, 'InvalidToken'),
      new Error('fetch failed: socket closed'),
    ]) {
      const posts = client({
        create: async () => {
          throw failure;
        },
      });
      await expect(createPostAtRkey(posts, 'did:plc:redacted', '3abc', record)).rejects.toBe(failure);
      expect(posts.gets).toBe(0);
    }
  });

  test('a rejected create with nothing at the key keeps the original error', async () => {
    const failure = new XRPCError(400, 'InvalidRequest', 'Invalid record');
    const posts = client({
      create: async () => {
        throw failure;
      },
      get: async () => {
        throw new XRPCError(400, 'RecordNotFound', 'Could not locate record');
      },
    });
    await expect(createPostAtRkey(posts, 'did:plc:redacted', '3abc', record)).rejects.toBe(failure);
  });
});
