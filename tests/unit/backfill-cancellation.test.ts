import { describe, expect, test } from 'bun:test';
import { isBackfillStillRequested } from '../../src/pipeline/backfill-cancellation.js';

const pending = (requestId: string, id = 'destination') => ({ id, requestId });

describe('backfill cancellation', () => {
  test('a durable job recovered after a restart is still wanted', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        requestId: 'request-1',
        durableJob: { status: 'pending' },
        // Nothing in memory: the process that queued this request is gone.
        pending: [],
      }),
    ).toBe(true);
  });

  test('a job claimed by this run is still wanted even though it is no longer due', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        requestId: 'request-1',
        durableJob: { status: 'processing' },
        pending: [],
      }),
    ).toBe(true);
  });

  test('a parked job stops the run', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        requestId: 'request-1',
        durableJob: { status: 'failed' },
        pending: [pending('request-1')],
      }),
    ).toBe(false);
  });

  test('a cancelled request with no durable row stops the run', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        requestId: 'request-1',
        durableJob: null,
        pending: [pending('request-2')],
      }),
    ).toBe(false);
  });

  test('an in-memory request without a durable row is still honoured', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        requestId: 'request-1',
        durableJob: null,
        pending: [pending('request-1')],
      }),
    ).toBe(true);
  });

  test('without a request id any pending backfill for the destination counts', () => {
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        pending: [pending('request-9')],
      }),
    ).toBe(true);
    expect(
      isBackfillStillRequested({
        destinationId: 'destination',
        pending: [pending('request-9', 'other-destination')],
      }),
    ).toBe(false);
  });
});
