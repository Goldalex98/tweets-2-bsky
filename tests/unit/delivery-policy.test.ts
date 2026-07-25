import { describe, expect, test } from 'bun:test';
import type { AIConfig } from '../../src/config/schemas.js';
import {
  LEGACY_DELIVERY_POLICY,
  mergeSnapshotAiCredentials,
  recoveredRecordMatches,
  resolveDeliveryPolicy,
} from '../../src/pipeline/delivery-policy.js';

const filters = (overrides: Record<string, boolean>) =>
  ({
    replies: true,
    selfReplies: true,
    externalReplies: false,
    reposts: false,
    quotes: true,
    mediaOnly: false,
    ...overrides,
  }) as never;

describe('accepted route policy at delivery time', () => {
  test('a snapshot that allows reposts and external replies is honoured', () => {
    expect(
      resolveDeliveryPolicy({
        snapshot: { filters: filters({ reposts: true, externalReplies: true }) },
      }),
    ).toEqual({ allowReposts: true, allowExternalReplies: true });
  });

  test('the snapshot wins over the route policy that has since changed', () => {
    expect(
      resolveDeliveryPolicy({
        snapshot: { filters: filters({ reposts: true, externalReplies: false }) },
        routeFilters: filters({ reposts: false, externalReplies: true }),
      }),
    ).toEqual({ allowReposts: true, allowExternalReplies: false });
  });

  test('a pre-filters snapshot falls back to the current route policy', () => {
    expect(
      resolveDeliveryPolicy({
        snapshot: {},
        routeFilters: filters({ reposts: true, externalReplies: true }),
      }),
    ).toEqual({ allowReposts: true, allowExternalReplies: true });
  });

  test('with neither snapshot nor route the legacy skips still apply', () => {
    expect(resolveDeliveryPolicy({})).toEqual(LEGACY_DELIVERY_POLICY);
  });
});

describe('snapshotted AI credentials', () => {
  const currentAi = {
    enabled: true,
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'live-secret',
    imageAltText: { enabled: true },
  } as unknown as AIConfig;

  test('the live API key is merged into a snapshot that omitted it', () => {
    const snapshotAi = {
      enabled: true,
      provider: 'openai',
      model: 'gpt-snapshotted',
      imageAltText: { enabled: true },
      overrides: { imageAltText: false },
    } as unknown as AIConfig;

    const merged = mergeSnapshotAiCredentials(snapshotAi, currentAi);
    expect(merged.apiKey).toBe('live-secret');
    // Snapshotted settings, not current ones, still decide behaviour.
    expect(merged.model).toBe('gpt-snapshotted');
    expect('overrides' in merged).toBe(false);
  });

  test('a rotated key replaces a key a legacy snapshot may still carry', () => {
    const legacySnapshotAi = { ...currentAi, apiKey: 'rotated-out' } as AIConfig;
    expect(mergeSnapshotAiCredentials(legacySnapshotAi, currentAi).apiKey).toBe('live-secret');
  });

  test('an item without a snapshot delivers with the current AI config', () => {
    expect(mergeSnapshotAiCredentials(undefined, currentAi)).toEqual(currentAi);
  });
});

describe('deterministic rkey recovery', () => {
  test('adopts an existing record only when its text is the text being posted', () => {
    expect(recoveredRecordMatches({ text: 'hello world' }, { text: 'hello world' })).toBe(true);
  });

  test('refuses a record whose content differs', () => {
    expect(recoveredRecordMatches({ text: 'somebody else post' }, { text: 'hello world' })).toBe(false);
  });

  test('refuses anything that is not a readable record', () => {
    expect(recoveredRecordMatches(undefined, { text: 'hello' })).toBe(false);
    expect(recoveredRecordMatches(null, { text: 'hello' })).toBe(false);
    expect(recoveredRecordMatches('hello', { text: 'hello' })).toBe(false);
    expect(recoveredRecordMatches({ text: 42 }, { text: 'hello' })).toBe(false);
    expect(recoveredRecordMatches({ text: 'hello' }, {})).toBe(false);
  });
});
