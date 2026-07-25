import { describe, expect, test } from 'bun:test';
import {
  applyTextCapabilities,
  type AIProviderClient,
} from '../../src/ai-manager.js';
import type { AIConfig, DestinationAIOverrides } from '../../src/config/schemas.js';

const baseConfig = (enabled: Partial<Record<'cleanup' | 'translation' | 'summarization' | 'hashtags', boolean>> = {}): AIConfig =>
  ({
    enabled: false,
    purpose: 'image-alt-text',
    provider: 'custom',
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.invalid',
    maxAltTextChars: 1000,
    privacyDescription: 'test',
    textCapabilities: {
      translation: {
        enabled: enabled.translation === true,
        purpose: 'translation',
        privacyDescription: 'test',
      },
      summarization: {
        enabled: enabled.summarization === true,
        purpose: 'summarization',
        privacyDescription: 'test',
      },
      cleanup: {
        enabled: enabled.cleanup === true,
        purpose: 'cleanup',
        privacyDescription: 'test',
      },
      hashtags: {
        enabled: enabled.hashtags === true,
        purpose: 'hashtags',
        privacyDescription: 'test',
      },
    },
  }) as AIConfig;

describe('applyTextCapabilities', () => {
  test('is a noop when all capabilities are disabled', async () => {
    const result = await applyTextCapabilities('Hello world', { config: baseConfig() });
    expect(result.text).toBe('Hello world');
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test('applies cleanup then hashtags in order', async () => {
    const client: AIProviderClient = {
      async complete(request) {
        if (request.purpose === 'cleanup') return 'Cleaned post';
        if (request.purpose === 'hashtags') return '#launch #news';
        throw new Error(`unexpected purpose ${request.purpose}`);
      },
    };
    const result = await applyTextCapabilities('messy post', {
      config: baseConfig({ cleanup: true, hashtags: true }),
      client,
    });
    expect(result.text).toBe('Cleaned post\n\n#launch #news');
    expect(result.applied).toEqual(['cleanup', 'hashtags']);
  });

  test('continues when a capability fails', async () => {
    const client: AIProviderClient = {
      async complete(request) {
        if (request.purpose === 'cleanup') throw new Error('provider down');
        if (request.purpose === 'translation') return 'Texto traducido';
        throw new Error(`unexpected purpose ${request.purpose}`);
      },
    };
    const result = await applyTextCapabilities('original', {
      config: baseConfig({ cleanup: true, translation: true }),
      client,
    });
    expect(result.text).toBe('Texto traducido');
    expect(result.applied).toEqual(['translation']);
    expect(result.failed).toEqual(['cleanup']);
  });

  test('respects destination disable overrides', async () => {
    const overrides: DestinationAIOverrides = {
      imageAltText: 'inherit',
      textCapabilities: {
        translation: 'disabled',
        summarization: 'inherit',
        cleanup: 'disabled',
        hashtags: 'inherit',
      },
    };
    const client: AIProviderClient = {
      async complete() {
        return 'should not run';
      },
    };
    const result = await applyTextCapabilities('keep me', {
      config: baseConfig({ cleanup: true, translation: true }),
      overrides,
      client,
    });
    expect(result.text).toBe('keep me');
    expect(result.applied).toEqual([]);
  });
});
