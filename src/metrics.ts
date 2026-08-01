export type MetricCounter =
  | 'sweeps'
  | 'fetchSuccess'
  | 'fetchFailure'
  | 'discovered'
  | 'filtered'
  | 'enqueued'
  | 'posted'
  | 'skipped'
  | 'failed'
  | 'retries'
  | 'aiRequests'
  | 'aiFailures'
  | 'policySkips'
  | 'duplicateSuppressed'
  | 'snapshotRewrites'
  | 'ingestionAccepted'
  | 'ingestionRejected'
  | 'digestRuns'
  | 'digestFailures'
  | 'repostRecoveredObservations'
  | 'repostWrapperFallbackObservations';

export type MetricHistogram = 'queueDelayMs' | 'postDurationMs';

const COUNTERS: MetricCounter[] = [
  'sweeps',
  'fetchSuccess',
  'fetchFailure',
  'discovered',
  'filtered',
  'enqueued',
  'posted',
  'skipped',
  'failed',
  'retries',
  'aiRequests',
  'aiFailures',
  'policySkips',
  'duplicateSuppressed',
  'snapshotRewrites',
  'ingestionAccepted',
  'ingestionRejected',
  'digestRuns',
  'digestFailures',
  // Fetch observations intentionally include repeated timeline sightings. The
  // names make that scope explicit instead of implying unique accepted posts.
  'repostRecoveredObservations',
  'repostWrapperFallbackObservations',
];

interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  average: number | null;
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  counters: Record<MetricCounter, number>;
  histograms: Record<MetricHistogram, HistogramSnapshot>;
}

class Histogram {
  private count = 0;
  private sum = 0;
  private min: number | null = null;
  private max: number | null = null;

  observe(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.count += 1;
    this.sum += value;
    this.min = this.min === null ? value : Math.min(this.min, value);
    this.max = this.max === null ? value : Math.max(this.max, value);
  }

  snapshot(): HistogramSnapshot {
    return {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      average: this.count === 0 ? null : this.sum / this.count,
    };
  }
}

export class MetricsService {
  private readonly startedAt: number;
  private readonly counters = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<MetricCounter, number>;
  private readonly queueDelayMs = new Histogram();
  private readonly postDurationMs = new Histogram();

  constructor(private readonly clock: { now(): number } = Date) {
    this.startedAt = clock.now();
  }

  increment(counter: MetricCounter, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    this.counters[counter] += amount;
  }

  observe(histogram: MetricHistogram, value: number): void {
    this[histogram].observe(value);
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 1000)),
      counters: { ...this.counters },
      histograms: {
        queueDelayMs: this.queueDelayMs.snapshot(),
        postDurationMs: this.postDurationMs.snapshot(),
      },
    };
  }

  toPrometheus(): string {
    const snapshot = this.snapshot();
    const lines = [
      '# HELP tweets2bsky_uptime_seconds Process uptime.',
      '# TYPE tweets2bsky_uptime_seconds gauge',
      `tweets2bsky_uptime_seconds ${snapshot.uptimeSeconds}`,
    ];
    for (const [key, value] of Object.entries(snapshot.counters)) {
      const name = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      lines.push(`# TYPE tweets2bsky_${name}_total counter`, `tweets2bsky_${name}_total ${value}`);
    }
    for (const [key, value] of Object.entries(snapshot.histograms)) {
      const name = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      lines.push(
        `# TYPE tweets2bsky_${name} summary`,
        `tweets2bsky_${name}_count ${value.count}`,
        `tweets2bsky_${name}_sum ${value.sum}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

export const metricsService = new MetricsService();
