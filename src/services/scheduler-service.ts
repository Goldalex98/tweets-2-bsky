import type { SchedulerCommand } from '../scheduler-command.js';

export interface SchedulerRuntimeConfig {
  scheduler: {
    enabled: boolean;
    runOnStartup: boolean;
  };
}

export interface SchedulerClock {
  now(): number;
}

export interface SchedulerServiceDependencies<Config extends SchedulerRuntimeConfig, Backfill, PinSync> {
  clock: SchedulerClock;
  sleep(durationMs: number): Promise<void>;
  getConfig(): Config;
  getNextCheckTime(): number;
  getWakeSignal(): number;
  getCommandsSince(sequence: number): readonly SchedulerCommand[];
  getPendingBackfills(): readonly Backfill[];
  getPendingPinSyncs(): readonly PinSync[];
  processPinSyncs(pinSyncs: readonly PinSync[], config: Config): Promise<void>;
  processBackfills(backfills: readonly Backfill[], config: Config): Promise<void>;
  runSweep(config: Config): Promise<void>;
  updateLastCheckTime(): void;
  onBackfillsDrained?(context: { deferredSweep: boolean; scheduledSweepWasDue: boolean }): void;
  onSweepStarted?(context: { deferred: boolean; startedAt: number }): void;
  onSweepCompleted?(): void;
}

export interface SchedulerIterationResult {
  processedPinSyncs: number;
  processedBackfills: number;
  ranSweep: boolean;
  deferredSweep: boolean;
}

/**
 * Owns daemon scheduling policy while all I/O and application work remain
 * injected. `runIteration` is intentionally public so timing and command
 * semantics can be tested without timers or a live server.
 */
export class SchedulerService<Config extends SchedulerRuntimeConfig, Backfill, PinSync> {
  private deferredScheduledRun = false;
  private lastWakeSignal: number;
  private startupRunPending: boolean;

  constructor(private readonly dependencies: SchedulerServiceDependencies<Config, Backfill, PinSync>) {
    const config = dependencies.getConfig();
    this.lastWakeSignal = dependencies.getWakeSignal();
    this.startupRunPending = config.scheduler.enabled && config.scheduler.runOnStartup;
  }

  get state(): Readonly<{
    deferredScheduledRun: boolean;
    lastWakeSignal: number;
    startupRunPending: boolean;
  }> {
    return {
      deferredScheduledRun: this.deferredScheduledRun,
      lastWakeSignal: this.lastWakeSignal,
      startupRunPending: this.startupRunPending,
    };
  }

  async runIteration(): Promise<SchedulerIterationResult> {
    const now = this.dependencies.clock.now();
    const config = this.dependencies.getConfig();
    const commands = this.dependencies.getCommandsSince(this.lastWakeSignal);
    const latestCommand = commands[commands.length - 1];
    if (latestCommand) this.lastWakeSignal = latestCommand.sequence;

    const runNowRequested = commands.some((command) => command.kind === 'run-now');
    const scheduledSweepWasDue =
      config.scheduler.enabled && now >= this.dependencies.getNextCheckTime();

    const pinSyncs = this.dependencies.getPendingPinSyncs();
    await this.dependencies.processPinSyncs(pinSyncs, config);

    const pendingBackfills = this.dependencies.getPendingBackfills();
    const shouldRunScheduledCycle =
      runNowRequested ||
      this.startupRunPending ||
      scheduledSweepWasDue ||
      (config.scheduler.enabled && this.deferredScheduledRun && pendingBackfills.length === 0);

    if (scheduledSweepWasDue && pendingBackfills.length > 0) {
      this.deferredScheduledRun = true;
    }

    if (pendingBackfills.length > 0) {
      await this.dependencies.processBackfills(pendingBackfills, config);
      if (this.dependencies.getPendingBackfills().length === 0) {
        this.dependencies.onBackfillsDrained?.({
          deferredSweep: this.deferredScheduledRun,
          scheduledSweepWasDue,
        });
      }
      await this.sleepWithWake(2_000);
      await this.sleepWithWake(5_000);
      return {
        processedPinSyncs: pinSyncs.length,
        processedBackfills: pendingBackfills.length,
        ranSweep: false,
        deferredSweep: this.deferredScheduledRun,
      };
    }

    if (shouldRunScheduledCycle) {
      const deferred = this.deferredScheduledRun && !scheduledSweepWasDue;
      this.dependencies.onSweepStarted?.({ deferred, startedAt: now });
      this.deferredScheduledRun = false;
      this.startupRunPending = false;
      this.dependencies.updateLastCheckTime();
      await this.dependencies.runSweep(config);
      this.dependencies.onSweepCompleted?.();
      await this.sleepWithWake(5_000);
      return {
        processedPinSyncs: pinSyncs.length,
        processedBackfills: 0,
        ranSweep: true,
        deferredSweep: false,
      };
    }

    await this.sleepWithWake(5_000);
    return {
      processedPinSyncs: pinSyncs.length,
      processedBackfills: 0,
      ranSweep: false,
      deferredSweep: this.deferredScheduledRun,
    };
  }

  async runForever(): Promise<never> {
    while (true) {
      await this.runIteration();
    }
  }

  private async sleepWithWake(durationMs: number): Promise<void> {
    const end = this.dependencies.clock.now() + durationMs;
    while (this.dependencies.clock.now() < end) {
      if (this.dependencies.getWakeSignal() > this.lastWakeSignal) return;
      const remainingMs = Math.max(0, end - this.dependencies.clock.now());
      await this.dependencies.sleep(Math.min(250, remainingMs));
    }
  }
}
