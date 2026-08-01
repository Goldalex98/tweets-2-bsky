import { describe, expect, test } from 'bun:test';
import {
  describeDeliveryFallback,
  parseDeliveryDiagnostics,
  serializeDeliveryDiagnostics,
} from '../../src/delivery-diagnostics.js';
import { buildPollNote } from '../../src/tweet-cards.js';

describe('buildPollNote', () => {
  test('builds a non-emoji note with choice summary and vote action', () => {
    const note = buildPollNote(
      {
        name: 'poll2choice_text_only',
        binding_values: {
          choice1_label: { string_value: 'Yes' },
          choice2_label: { string_value: 'No' },
          counts_are_final: { boolean_value: false },
        },
      },
      'https://x.com/example/status/1',
    );
    expect(note).toContain('This post has a poll (Yes / No)');
    expect(note).toContain('Vote on X: https://x.com/example/status/1');
    expect(note).not.toContain('📊');
  });

  test('uses results wording when counts are final', () => {
    const note = buildPollNote(
      {
        name: 'poll2choice_text_only',
        binding_values: [
          { key: 'choice1_label', value: { string_value: 'A' } },
          { key: 'choice2_label', value: { string_value: 'B' } },
          { key: 'counts_are_final', value: { boolean_value: true } },
        ],
      },
      'https://x.com/example/status/2',
    );
    expect(note).toContain('See the results on X');
  });
});

describe('delivery diagnostics helpers', () => {
  test('round-trips fallback events', () => {
    const raw = serializeDeliveryDiagnostics([
      { kind: 'video-link', reason: 'Video too long (200.0s)' },
      { kind: 'poll-note', reason: 'Poll mirrored as text note with X link' },
      { kind: 'repost-wrapper-fallback', reason: 'Nested content missing' },
    ]);
    expect(raw).toBeTruthy();
    const parsed = parseDeliveryDiagnostics(raw);
    expect(parsed).toHaveLength(3);
    const first = parsed[0];
    expect(first).toBeDefined();
    expect(describeDeliveryFallback(first)).toBe('Video link fallback');
    expect(describeDeliveryFallback(parsed[2])).toBe('Repost content unavailable; linked to X fallback');
  });
});
