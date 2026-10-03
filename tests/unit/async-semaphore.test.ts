import { describe, expect, test } from 'bun:test';
import { AsyncSemaphore } from '../../src/async-semaphore.js';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('async semaphore', () => {
  test('one slot runs tasks one at a time, in order', async () => {
    const semaphore = new AsyncSemaphore(1);
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    const task = (name: string) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${name}`);
      running -= 1;
      return name;
    };
    const results = await Promise.all([
      semaphore.run(task('a'), 1_000),
      semaphore.run(task('b'), 1_000),
      semaphore.run(task('c'), 1_000),
    ]);
    expect(results.map((outcome) => (outcome.ran ? outcome.value : outcome.reason))).toEqual(['a', 'b', 'c']);
    expect(peak).toBe(1);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  test('a waiter that times out gives up without taking a slot later', async () => {
    const semaphore = new AsyncSemaphore(1);
    const holder = deferred();
    const first = semaphore.run(() => holder.promise, 1_000);
    let lateRan = false;
    const late = await semaphore.run(async () => {
      lateRan = true;
    }, 10);
    expect(late).toEqual({ ran: false, reason: 'timeout' });
    holder.resolve();
    await first;
    expect(lateRan).toBe(false);
    expect(await semaphore.run(async () => 'free again', 10)).toEqual({ ran: true, value: 'free again' });
  });

  test('a failing task frees its slot', async () => {
    const semaphore = new AsyncSemaphore(1);
    await expect(
      semaphore.run(async () => {
        throw new Error('chromium crashed');
      }, 10),
    ).rejects.toThrow('chromium crashed');
    expect(await semaphore.run(async () => 'next', 10)).toEqual({ ran: true, value: 'next' });
  });

  test('zero slots never runs the task', async () => {
    const semaphore = new AsyncSemaphore(0);
    let ran = false;
    expect(
      await semaphore.run(async () => {
        ran = true;
      }, 10),
    ).toEqual({ ran: false, reason: 'disabled' });
    expect(ran).toBe(false);
  });

  test('an aborted waiter leaves the line at once and never runs', async () => {
    const semaphore = new AsyncSemaphore(1);
    const holder = deferred();
    const first = semaphore.run(() => holder.promise, 1_000);
    const controller = new AbortController();
    let abortedRan = false;
    const waiting = semaphore.run(
      async () => {
        abortedRan = true;
      },
      60_000,
      controller.signal,
    );
    const next = semaphore.run(async () => 'next in line', 1_000);
    controller.abort();
    expect(await waiting).toEqual({ ran: false, reason: 'aborted' });
    holder.resolve();
    await first;
    expect(await next).toEqual({ ran: true, value: 'next in line' });
    expect(abortedRan).toBe(false);
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await semaphore.run(async () => 1, 10, preAborted.signal)).toEqual({ ran: false, reason: 'aborted' });
  });
});
