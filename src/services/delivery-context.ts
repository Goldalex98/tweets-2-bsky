import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface DeliveryContext {
  controller: AbortController;
  assertOwnership(): void;
  commit?(operation: () => void): boolean;
}

const delivery = new AsyncLocalStorage<DeliveryContext>();
const shutdown = new AbortController();

export class DestinationLeaseLostError extends Error {
  constructor() {
    super('Destination lease was lost');
  }
}

export function runWithDeliveryContext<T>(context: DeliveryContext, operation: () => Promise<T>): Promise<T> {
  return delivery.run(context, operation);
}

export function assertDeliveryActive(): void {
  shutdown.signal.throwIfAborted();
  const context = delivery.getStore();
  context?.controller.signal.throwIfAborted();
  context?.assertOwnership();
}

export function commitDeliveryState(operation: () => void): void {
  assertDeliveryActive();
  const context = delivery.getStore();
  if (context?.commit) {
    if (!context.commit(operation)) {
      context.controller.abort(new DestinationLeaseLostError());
      throw new DestinationLeaseLostError();
    }
  } else operation();
}

export function deliverySignal(signal?: AbortSignal | null): AbortSignal {
  const signals = [shutdown.signal];
  const context = delivery.getStore();
  if (context) signals.push(context.controller.signal);
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

export function stopDelivery(): void {
  shutdown.abort(new Error('Application is shutting down'));
}

export function withDeliveryDeadline<T>(operation: () => Promise<T>, ms: number, message: string): Promise<T> {
  const context = delivery.getStore() ?? { controller: new AbortController(), assertOwnership() {} };
  return runWithDeliveryContext(context, () => awaitDeliveryDeadline(operation(), ms, message));
}

export async function deliverySleep(ms: number): Promise<void> {
  assertDeliveryActive();
  await delay(ms, undefined, { signal: deliverySignal() });
  assertDeliveryActive();
}

/** Cached clients resolve the active scope at request time, never at creation. */
export async function fetchWithDeliveryContext(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 180_000,
): Promise<Response> {
  assertDeliveryActive();
  return globalThis.fetch(input, {
    ...init,
    signal: deliverySignal(
      AbortSignal.any([
        ...(input instanceof Request ? [input.signal] : []),
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]),
    ),
  });
}

export const deliveryFetch: typeof globalThis.fetch = (input, init) => fetchWithDeliveryContext(input, init);

/** Abort first, but keep the owner's lock until the operation actually settles. */
export async function awaitDeliveryDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const context = delivery.getStore();
  let expired = false;
  const error = new Error(message);
  const timer = setTimeout(() => {
    expired = true;
    console.warn(
      '[Delivery] Operation deadline reached; cancellation requested, retaining ownership until settlement.',
    );
    context?.controller.abort(error);
  }, ms);
  try {
    const result = await promise;
    if (expired) throw error;
    assertDeliveryActive();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
