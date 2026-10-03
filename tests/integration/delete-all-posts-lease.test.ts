import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createTemporaryDataDir } from '../helpers/temporary-data-dir.js';

const moduleUrl = (name: string) => JSON.stringify(new URL(`../../src/${name}`, import.meta.url).href);

test('delete-all holds the destination lease, caps concurrency and stops on a rate limit', async () => {
  const temporary = createTemporaryDataDir();
  const resultPath = path.join(temporary.path, 'delete-all.json');
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
      const configManager = await import(${moduleUrl('config-manager.ts')});
      const { deleteAllPosts } = await import(${moduleUrl('bsky.ts')});
      const { destinationLeaseService } = await import(${moduleUrl('db.ts')});
      const { DestinationBusyError } = await import(${moduleUrl('destination-maintenance.ts')});
      configManager.addMapping({
        twitterUsernames: ['source'],
        pausedTwitterUsernames: [],
        bskyIdentifier: 'destination.example',
        bskyPassword: '<redacted-app-password>',
        bskyServiceUrl: 'https://bsky.social',
        bskyDid: 'did:plc:destination',
        bskyCanonicalHandle: 'destination.example',
      });
      const destinationId = configManager.getConfig().mappings[0].id;
      const did = 'did:plc:destination';
      const page = (prefix, count) => Array.from({ length: count }, (_, index) => ({
        uri: 'at://' + did + '/app.bsky.feed.post/' + prefix + index, cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku', value: {},
      }));
      let inFlight = 0;
      let maxInFlight = 0;
      let deletes = 0;
      let workerCouldAcquire = false;
      let workersSawLease = false;
      let rateLimit = false;
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = new URL(request.url);
        if (url.hostname !== 'bsky.social') throw new Error('Unexpected fixture outbound request');
        if (url.pathname.endsWith('com.atproto.server.createSession')) {
          return Response.json({ did, handle: 'destination.example', accessJwt: 'redacted-access', refreshJwt: 'redacted-refresh', active: true });
        }
        if (url.pathname.endsWith('com.atproto.repo.listRecords')) {
          return Response.json(url.searchParams.get('cursor')
            ? { records: page('b', 12) }
            : { records: page('a', 12), cursor: 'next' });
        }
        if (url.pathname.endsWith('com.atproto.repo.deleteRecord')) {
          const body = await request.json();
          workerCouldAcquire ||= Boolean(destinationLeaseService.acquire({ destinationKey: destinationId, ownerId: 'worker', ttlMs: 60000 }));
          workersSawLease ||= destinationLeaseService.listHeldByOthers('worker').includes(destinationId);
          if (rateLimit && body.rkey === 'b3') {
            return Response.json({ error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }, { status: 429 });
          }
          inFlight++;
          deletes++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return Response.json({});
        }
        throw new Error('Unexpected fixture lexicon ' + url.pathname);
      };

      const deleted = await deleteAllPosts(destinationId);
      const leaseAfter = destinationLeaseService.get(destinationId);

      rateLimit = true;
      deletes = 0;
      const rateLimited = await deleteAllPosts(destinationId).then(() => 'resolved', (error) => error.status ?? String(error));
      const deletesBeforeStop = deletes;

      destinationLeaseService.acquire({ destinationKey: destinationId, ownerId: 'worker', ttlMs: 60000 });
      const busy = await deleteAllPosts(destinationId).then(() => 'resolved', (error) => error instanceof DestinationBusyError);

      // A restart clears this host's earlier maintenance leases but no other owner's.
      destinationLeaseService.release(destinationId, 'worker');
      for (const [key, owner] of [['a', 'maintenance:host:1:dead'], ['b', 'maintenance:other:1:live'], ['c', 'maintenance:host:2:self']]) {
        destinationLeaseService.acquire({ destinationKey: key, ownerId: owner, ttlMs: 60000 });
      }
      const cleared = destinationLeaseService.releaseOwnersWithPrefix('maintenance:host:', 'maintenance:host:2:self');
      const remaining = ['a', 'b', 'c'].filter((key) => destinationLeaseService.get(key) !== null);

      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        cleared, remaining,
        deleted, maxInFlight, workerCouldAcquire, workersSawLease, leaseReleased: leaseAfter === null,
        rateLimited, deletesBeforeStop, busy,
      }));
    `,
      ],
      { env: temporary.env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(result).toMatchObject({
      deleted: 24,
      maxInFlight: 5,
      // A queue worker can neither take nor ignore the destination mid-delete.
      workerCouldAcquire: false,
      workersSawLease: true,
      leaseReleased: true,
      rateLimited: 429,
      busy: true,
      cleared: 1,
      remaining: ['b', 'c'],
    });
    // The first page is deleted, then the rate limit stops the second page early.
    expect(result.deletesBeforeStop).toBeGreaterThanOrEqual(12);
    expect(result.deletesBeforeStop).toBeLessThan(23);
  } finally {
    temporary.cleanup();
  }
}, 30000);
