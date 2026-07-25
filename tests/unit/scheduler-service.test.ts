import { describe, expect, test } from 'bun:test';
import {
  type SchedulerRuntimeConfig,
  SchedulerService,
  type SchedulerServiceDependencies,
} from '../../src/services/scheduler-service.js';
import type { SchedulerCommand } from '../../src/scheduler-command.js';

interface TestConfig extends SchedulerRuntimeConfig {
  name: string;
}

interface Harness {
  service: SchedulerService<TestConfig, string, string>;
  events: string[];
  commands: SchedulerCommand[];
  backfills: string[];
  pins: string[];
  config: TestConfig;
  setNow(value: number): void;
}

function createHarness(options: {
  enabled?: boolean;
  runOnStartup?: boolean;
  now?: number;
  nextCheckTime?: number;
} = {}): Harness {
  let now = options.now ?? 1_000;
  const events: string[] = [];
  const commands: SchedulerCommand[] = [];
  const backfills: string[] = [];
  const pins: string[] = [];
  const config: TestConfig = {
    name: 'test',
    scheduler: {
      enabled: options.enabled ?? true,
      runOnStartup: options.runOnStartup ?? false,
    },
  };
  const dependencies: SchedulerServiceDependencies<TestConfig, string, string> = {
    clock: { now: () => now },
    sleep: async (durationMs) => {
      events.push(`sleep:${durationMs}`);
      now += durationMs;
    },
    getConfig: () => config,
    getNextCheckTime: () => options.nextCheckTime ?? Number.POSITIVE_INFINITY,
    getWakeSignal: () => commands.at(-1)?.sequence ?? 0,
    getCommandsSince: (sequence) => commands.filter((command) => command.sequence > sequence),
    getPendingBackfills: () => [...backfills],
    getPendingPinSyncs: () => [...pins],
    processPinSyncs: async (items) => {
      events.push(`pins:${items.join(',')}`);
      pins.splice(0);
    },
    processBackfills: async (items) => {
      events.push(`backfills:${items.join(',')}`);
      backfills.splice(0);
    },
    runSweep: async () => {
      events.push('sweep');
    },
    updateLastCheckTime: () => {
      events.push('update-last-check');
    },
    onBackfillsDrained: ({ deferredSweep }) => {
      events.push(`backfills-drained:${deferredSweep}`);
    },
    onSweepStarted: ({ deferred }) => {
      events.push(`sweep-started:${deferred}`);
    },
    onSweepCompleted: () => {
      events.push('sweep-completed');
    },
  };
  return {
    service: new SchedulerService(dependencies),
    events,
    commands,
    backfills,
    pins,
    config,
    setNow: (value) => {
      now = value;
    },
  };
}

describe('SchedulerService', () => {
  test('runs an enabled startup sweep once', async () => {
    const harness = createHarness({ runOnStartup: true });

    expect((await harness.service.runIteration()).ranSweep).toBe(true);
    expect(harness.events).toContain('update-last-check');
    expect(harness.events).toContain('sweep');

    harness.events.splice(0);
    expect((await harness.service.runIteration()).ranSweep).toBe(false);
    expect(harness.events).not.toContain('sweep');
  });

  test('run-now requests a sweep while reschedule only wakes the loop', async () => {
    const harness = createHarness({ enabled: false });
    harness.commands.push({ sequence: 1, kind: 'reschedule', requestedAt: 1_000 });

    expect((await harness.service.runIteration()).ranSweep).toBe(false);

    harness.commands.push({ sequence: 2, kind: 'run-now', requestedAt: 2_000 });
    expect((await harness.service.runIteration()).ranSweep).toBe(true);
    expect(harness.service.state.lastWakeSignal).toBe(2);
  });

  test('defers a due scheduled sweep until queued backfills drain', async () => {
    const harness = createHarness({ now: 10_000, nextCheckTime: 9_000 });
    harness.backfills.push('backfill-1');

    const first = await harness.service.runIteration();
    expect(first.ranSweep).toBe(false);
    expect(first.deferredSweep).toBe(true);
    expect(harness.events).toContain('backfills:backfill-1');
    expect(harness.events).toContain('backfills-drained:true');

    harness.events.splice(0);
    harness.setNow(10_000);
    harness.config.scheduler.enabled = true;
    const second = await harness.service.runIteration();
    expect(second.ranSweep).toBe(true);
    expect(harness.events).toContain('sweep-started:false');
  });

  test('processes pin work before backfills and scheduled sweeps', async () => {
    const harness = createHarness({ runOnStartup: true });
    harness.pins.push('pin-1');
    harness.backfills.push('backfill-1');

    await harness.service.runIteration();

    expect(harness.events.indexOf('pins:pin-1')).toBeLessThan(harness.events.indexOf('backfills:backfill-1'));
    expect(harness.events).not.toContain('sweep');
  });
});
