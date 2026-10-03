import { describe, expect, test } from 'bun:test';
import {
  DestinationBusyError,
  DestinationMaintenanceRunner,
  DetachedTaskRunner,
  type MaintenanceLeaseStore,
  mapWithConcurrency,
} from '../../src/destination-maintenance.js';

const leaseStore = () => {
  const owners = new Map<string, string>();
  const store: MaintenanceLeaseStore & { owners: Map<string, string> } = {
    owners,
    acquire: (key, owner) => {
      const holder = owners.get(key);
      if (holder && holder !== owner) return false;
      owners.set(key, owner);
      return true;
    },
    renew: (key, owner) => owners.get(key) === owner,
    release: (key, owner) => {
      if (owners.get(key) === owner) owners.delete(key);
    },
  };
  return store;
};

describe('destination maintenance lease', () => {
  test('holds the lease while the task runs and releases it afterwards, even on failure', async () => {
    const store = leaseStore();
    const runner = new DestinationMaintenanceRunner(store, 60_000, 'maintenance');
    const seen = await runner.run('destination', async (lease) => ({
      holder: store.owners.get('destination'),
      renewed: lease.renew(),
    }));
    expect(seen).toEqual({ holder: 'maintenance', renewed: true });
    expect(store.owners.has('destination')).toBe(false);

    await expect(
      runner.run('destination', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(store.owners.has('destination')).toBe(false);
  });

  test('refuses a destination another writer holds, without touching its lease', async () => {
    const store = leaseStore();
    store.owners.set('destination', 'worker');
    const runner = new DestinationMaintenanceRunner(store, 60_000, 'maintenance');
    let ran = false;
    await expect(
      runner.run('destination', async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(DestinationBusyError);
    expect(ran).toBe(false);
    expect(store.owners.get('destination')).toBe('worker');
  });

  test('a second task on a destination this process already holds is refused, and the first keeps its lease', async () => {
    const store = leaseStore();
    const runner = new DestinationMaintenanceRunner(store, 60_000, 'maintenance');
    let release = () => {};
    const first = runner.run(
      'destination',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(runner.run('destination', async () => {})).rejects.toBeInstanceOf(DestinationBusyError);
    expect(store.owners.get('destination')).toBe('maintenance');
    release();
    await first;
    expect(store.owners.has('destination')).toBe(false);
  });
});

describe('detached tasks', () => {
  test('the caller does not wait, a running key is not started twice, and failures are reported', async () => {
    const errors: string[] = [];
    const runner = new DetachedTaskRunner((key, error) => errors.push(`${key}: ${(error as Error).message}`));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    const task = async () => {
      starts += 1;
      await gate;
      throw new Error('login failed');
    };
    expect(runner.start('housekeeping', task)).toBe(true);
    expect(runner.start('housekeeping', task)).toBe(false);
    expect(runner.isRunning('housekeeping')).toBe(true);
    release();
    await runner.settle();
    expect(starts).toBe(1);
    expect(errors).toEqual(['housekeeping: login failed']);
    expect(runner.isRunning('housekeeping')).toBe(false);
    expect(runner.start('housekeeping', async () => {})).toBe(true);
    await runner.settle();
  });

  test('settling a subset does not wait for the other tasks', async () => {
    const runner = new DetachedTaskRunner(() => {});
    let finishHousekeeping = () => {};
    runner.start(
      'housekeeping',
      () =>
        new Promise<void>((resolve) => {
          finishHousekeeping = resolve;
        }),
    );
    let pinDone = false;
    runner.start('pin:destination', async () => {
      pinDone = true;
    });
    await runner.settle((key) => key.startsWith('pin:'));
    expect(pinDone).toBe(true);
    expect(runner.isRunning('housekeeping')).toBe(true);
    finishHousekeeping();
    await runner.settle();
  });
});

describe('bounded concurrency', () => {
  test('keeps order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      inFlight -= 1;
      return value * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
