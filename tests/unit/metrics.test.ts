import { expect, test } from 'bun:test';
import { MetricsService } from '../../src/metrics.js';

test('metrics collect counters and latency without identifier labels', () => {
  let now = 1000;
  const metrics = new MetricsService({ now: () => now });
  metrics.increment('sweeps');
  metrics.increment('discovered', 3);
  metrics.increment('enqueued', 2);
  metrics.observe('queueDelayMs', 250);
  metrics.observe('queueDelayMs', 750);
  metrics.observe('postDurationMs', 1200);
  now = 6000;

  const snapshot = metrics.snapshot();
  expect(snapshot.uptimeSeconds).toBe(5);
  expect(snapshot.counters).toMatchObject({ sweeps: 1, discovered: 3, enqueued: 2 });
  expect(snapshot.histograms.queueDelayMs).toEqual({
    count: 2,
    sum: 1000,
    min: 250,
    max: 750,
    average: 500,
  });
  const prometheus = metrics.toPrometheus();
  expect(prometheus).toContain('tweets2bsky_sweeps_total 1');
  expect(prometheus).not.toContain('source-');
  expect(prometheus).not.toContain('destination-');
});
