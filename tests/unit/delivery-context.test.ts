import { describe, expect, test } from 'bun:test';
import {
  assertDeliveryActive,
  awaitDeliveryDeadline,
  deliverySignal,
  deliverySleep,
  runWithDeliveryContext,
} from '../../src/services/delivery-context.js';

describe('delivery cancellation', () => {
  test('deadline aborts but retains scope until an uncancellable operation settles', async () => {
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    let settled = false;
    const operation = runWithDeliveryContext({ controller, assertOwnership() {} }, async () => {
      try {
        await awaitDeliveryDeadline(
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
          5,
          'timed out',
        );
      } finally {
        settled = true;
      }
    });
    const result = operation.catch((error) => error.message);
    await Bun.sleep(20);
    expect(controller.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    finish?.();
    expect(await result).toBe('timed out');
    expect(settled).toBe(true);
  });

  test('abort interrupts pacing and forbids subsequent work without affecting another scope', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const blocked = runWithDeliveryContext({ controller: first, assertOwnership() {} }, async () => {
      await deliverySleep(10000);
      throw new Error('must not reach next publication');
    }).catch((error) => error.name);
    first.abort();
    expect(await blocked).toBe('AbortError');
    await runWithDeliveryContext({ controller: second, assertOwnership() {} }, async () => {
      assertDeliveryActive();
      expect(deliverySignal().aborted).toBe(false);
    });
  });

  test('ownership is asserted before a mutation and caller abort signals are preserved', async () => {
    const caller = new AbortController();
    await runWithDeliveryContext(
      {
        controller: new AbortController(),
        assertOwnership() {
          throw new Error('lost lease');
        },
      },
      async () => {
        expect(() => assertDeliveryActive()).toThrow('lost lease');
        const combined = deliverySignal(caller.signal);
        caller.abort();
        expect(combined.aborted).toBe(true);
      },
    );
  });
});
