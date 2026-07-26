import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { getConfig } from './config-manager.js';
import type {
  AIConfig,
  AITextCapability,
  DestinationAIOverrides,
} from './config/schemas.js';
import { aiProviderUsageService } from './db.js';

export interface ResolvedAiProvider {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface AIProviderRequest {
  purpose: 'image-alt-text' | AITextCapability | 'provider-test';
  prompt: string;
  image?: { buffer: Buffer; mimeType: string };
  maxOutputChars: number;
}

export interface AIProviderClient {
  complete(request: AIProviderRequest): Promise<string | undefined>;
}

// Determine Provider and Credentials.
// Priority: AI Config > Environment Variables. Any legacy top-level
// geminiApiKey is folded into aiConfig by normalizeAiConfig before this runs.
// Returns null when alt-text generation is effectively disabled (no usable credentials).
export function resolveAiProvider(
  aiConfig: AIConfig = getConfig().ai,
  overrides?: DestinationAIOverrides,
  purpose: 'image-alt-text' | AITextCapability = 'image-alt-text',
): ResolvedAiProvider | null {
  const provider = aiConfig.provider || 'gemini';
  const override =
    purpose === 'image-alt-text'
      ? overrides?.imageAltText
      : overrides?.textCapabilities[purpose];
  const globallyEnabled =
    purpose === 'image-alt-text'
      ? aiConfig.enabled
      : aiConfig.textCapabilities[purpose].enabled;
  if (override === 'disabled' || (override !== 'enabled' && !globallyEnabled)) return null;
  let apiKey = aiConfig.apiKey;
  let model = aiConfig.model;
  const baseUrl = aiConfig.baseUrl;

  // Fallbacks for Environment Variables
  if (!apiKey) {
    if (process.env.AI_API_KEY) apiKey = process.env.AI_API_KEY;
    else if (provider === 'gemini') apiKey = process.env.GEMINI_API_KEY;
    else if (provider === 'openai') apiKey = process.env.OPENAI_API_KEY;
    else if (provider === 'anthropic') apiKey = process.env.ANTHROPIC_API_KEY;
  }

  // API Key is mandatory for Gemini and Anthropic
  if (!apiKey && (provider === 'gemini' || provider === 'anthropic')) {
    return null;
  }

  // OpenAI without a key only makes sense against a custom base URL (e.g. a
  // local server); against api.openai.com it would fail on every image.
  if (provider === 'openai' && !apiKey && !baseUrl) {
    return null;
  }

  // Custom providers need at least a base URL to call.
  if (provider === 'custom' && !baseUrl) {
    return null;
  }

  // Default Models
  if (!model) {
    if (provider === 'gemini') model = 'models/gemini-2.5-flash';
    else if (provider === 'openai') model = 'gpt-4o';
    else if (provider === 'anthropic') model = 'claude-3-5-sonnet-20241022';
  }

  return { provider, apiKey, model, baseUrl };
}

// Whether alt-text generation is configured/enabled at all. Many instances
// run without it; callers should skip the generation step entirely when false.
export function isAltTextConfigured(overrides?: DestinationAIOverrides, aiConfig = getConfig().ai): boolean {
  return resolveAiProvider(aiConfig, overrides) !== null;
}

export async function generateAltText(
  buffer: Buffer,
  mimeType: string,
  contextText: string,
  options: { overrides?: DestinationAIOverrides; client?: AIProviderClient; config?: AIConfig } = {},
): Promise<string | undefined> {
  const aiConfig = options.config ?? getConfig().ai;
  const resolved = resolveAiProvider(aiConfig, options.overrides);
  if (!resolved) {
    return undefined;
  }
  const { provider, apiKey, model, baseUrl } = resolved;
  const started = Date.now();
  aiProviderUsageService.record({
    purpose: 'image-alt-text',
    provider,
    model,
    status: 'request',
    latencyMs: 0,
  });

  try {
    const prompt = buildAltTextPrompt(contextText);
    let raw: string | undefined;
    if (options.client) {
      raw = await options.client.complete({
        purpose: 'image-alt-text',
        prompt,
        image: { buffer, mimeType },
        maxOutputChars: aiConfig.maxAltTextChars,
      });
    } else {
      switch (provider) {
        case 'gemini':
          raw = await callGemini(apiKey ?? '', model || 'models/gemini-2.5-flash', buffer, mimeType, prompt);
          break;
        case 'openai':
        case 'custom':
          raw = await callOpenAICompatible(apiKey, model || 'gpt-4o', baseUrl, buffer, mimeType, prompt);
          break;
        case 'anthropic':
          raw = await callAnthropic(
            apiKey ?? '',
            model || 'claude-3-5-sonnet-20241022',
            baseUrl,
            buffer,
            mimeType,
            prompt,
          );
          break;
      }
    }
    aiProviderUsageService.record({
      purpose: 'image-alt-text',
      provider,
      model,
      status: 'success',
      latencyMs: Date.now() - started,
    });
    return normalizeAltTextOutput(raw, aiConfig.maxAltTextChars);
  } catch (err) {
    aiProviderUsageService.record({
      purpose: 'image-alt-text',
      provider,
      model,
      status: 'failure',
      latencyMs: Date.now() - started,
      errorCategory: 'provider-error',
    });
    console.warn(`[AI] ⚠️ Failed to generate alt text with ${provider}: ${sanitizeProviderError(err)}`);
    return undefined;
  }
}

const ALT_TEXT_CONTEXT_MAX_CHARS = 400;

function buildAltTextPrompt(contextText: string): string {
  const normalized = contextText.replace(/\s+/g, ' ').trim();
  const trimmed =
    normalized.length > ALT_TEXT_CONTEXT_MAX_CHARS
      ? `${normalized.slice(0, ALT_TEXT_CONTEXT_MAX_CHARS).trim()}...`
      : normalized;

  return [
    'Write one alt text description (1-2 sentences).',
    'Describe only what is visible.',
    'Use context to identify people/places/objects if relevant for search.',
    'Describe only this image; ignore other images in the post.',
    'Return only the alt text with no labels, quotes, or options.',
    'No hashtags or emojis.',
    `Context: "${trimmed}"`,
  ].join(' ');
}

function normalizeAltTextOutput(output: string | undefined, maxChars = 1000): string | undefined {
  if (!output) return undefined;

  let cleaned = output.trim();
  if (!cleaned) return undefined;

  cleaned = cleaned.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  cleaned = cleaned.replace(/^(alt\s*text|description)\s*[:\-]\s*/i, '').trim();

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line): line is string => Boolean(line));
  if (lines.length > 0) cleaned = lines[0] ?? '';

  cleaned = cleaned.replace(/^option\s*\d+\s*[:\-]\s*/i, '').trim();
  cleaned = cleaned.replace(/^[\-\*\d\.\)]+\s*/g, '').trim();
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned ? cleaned.slice(0, maxChars).trim() : undefined;
}

async function callGemini(
  apiKey: string,
  modelName: string,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: modelName }, { timeout: 60_000 });

  const result = await model.generateContent([
    prompt,
    {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType,
      },
    },
  ]);
  const response = await result.response;
  return response.text();
}

async function callOpenAICompatible(
  apiKey: string | undefined,
  model: string,
  baseUrl: string | undefined,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const base64Image = `data:${mimeType};base64,${buffer.toString('base64')}`;

  const payload = {
    model: model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt,
          },
          {
            type: 'image_url',
            image_url: {
              url: base64Image,
            },
          },
        ],
      },
    ],
    max_tokens: 300,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // OpenRouter specific headers (optional but good practice)
  if (url.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/tweets-2-bsky';
    headers['X-Title'] = 'Tweets to Bluesky';
  }

  const response = await axios.post(url, payload, { headers, timeout: 60_000 });

  return response.data.choices[0]?.message?.content || undefined;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  baseUrl: string | undefined,
  buffer: Buffer,
  mimeType: string,
  prompt: string,
): Promise<string | undefined> {
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/v1/messages` : 'https://api.anthropic.com/v1/messages';

  const base64Data = buffer.toString('base64');

  const payload = {
    model: model,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    ],
  };

  const response = await axios.post(url, payload, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 60_000,
  });

  return response.data.content[0]?.text || undefined;
}

function sanitizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:sk|AIza|Bearer)[-_A-Za-z0-9.]{8,}/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}

async function callProviderText(
  resolved: ResolvedAiProvider,
  prompt: string,
): Promise<string | undefined> {
  if (resolved.provider === 'gemini') {
    const model = new GoogleGenerativeAI(resolved.apiKey ?? '').getGenerativeModel(
      { model: resolved.model || 'models/gemini-2.5-flash' },
      { timeout: 60_000 },
    );
    const result = await model.generateContent(prompt);
    return (await result.response).text();
  }
  if (resolved.provider === 'anthropic') {
    const url = resolved.baseUrl
      ? `${resolved.baseUrl.replace(/\/+$/, '')}/v1/messages`
      : 'https://api.anthropic.com/v1/messages';
    const response = await axios.post(
      url,
      {
        model: resolved.model || 'claude-3-5-sonnet-20241022',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': resolved.apiKey ?? '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      },
    );
    return response.data.content?.[0]?.text;
  }
  const url = resolved.baseUrl
    ? `${resolved.baseUrl.replace(/\/+$/, '')}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';
  const response = await axios.post(
    url,
    {
      model: resolved.model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
      },
      timeout: 60_000,
    },
  );
  return response.data.choices?.[0]?.message?.content;
}

export function createAIProviderClient(resolved: ResolvedAiProvider): AIProviderClient {
  return {
    async complete(request) {
      const image = request.image;
      if (!image) return callProviderText(resolved, request.prompt);
      const empty = Buffer.alloc(0);
      const buffer = image?.buffer ?? empty;
      const mimeType = image?.mimeType ?? 'image/png';
      switch (resolved.provider) {
        case 'gemini':
          return callGemini(
            resolved.apiKey ?? '',
            resolved.model || 'models/gemini-2.5-flash',
            buffer,
            mimeType,
            request.prompt,
          );
        case 'openai':
        case 'custom':
          return callOpenAICompatible(
            resolved.apiKey,
            resolved.model || 'gpt-4o',
            resolved.baseUrl,
            buffer,
            mimeType,
            request.prompt,
          );
        case 'anthropic':
          return callAnthropic(
            resolved.apiKey ?? '',
            resolved.model || 'claude-3-5-sonnet-20241022',
            resolved.baseUrl,
            buffer,
            mimeType,
            request.prompt,
          );
      }
    },
  };
}

// Public-domain-style generated 1x1 transparent PNG. Provider tests never use
// or read user media.
const DISCLOSED_TEST_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export async function testAIProvider(options: {
  config?: AIConfig;
  client?: AIProviderClient;
  recordUsage?: typeof aiProviderUsageService.record;
} = {}): Promise<{
  success: boolean;
  provider: string;
  model?: string;
  latencyMs: number;
  testPayload: 'generated-1x1-transparent-png';
  error?: string;
}> {
  const config = options.config ?? getConfig().ai;
  // Provider testing is explicit and may validate credentials before the
  // feature toggle is enabled.
  const resolved = resolveAiProvider({ ...config, enabled: true });
  if (!resolved) {
    return {
      success: false,
      provider: config.provider,
      model: config.model,
      latencyMs: 0,
      testPayload: 'generated-1x1-transparent-png',
      error: 'Provider credentials or base URL are incomplete.',
    };
  }
  const client = options.client ?? createAIProviderClient(resolved);
  const record = options.recordUsage ?? aiProviderUsageService.record.bind(aiProviderUsageService);
  const started = Date.now();
  record({
    purpose: 'provider-test',
    provider: resolved.provider,
    model: resolved.model,
    status: 'request',
    latencyMs: 0,
  });
  try {
    await client.complete({
      purpose: 'provider-test',
      prompt: 'Connectivity test. Briefly identify this disclosed generated transparent test image.',
      image: { buffer: DISCLOSED_TEST_IMAGE, mimeType: 'image/png' },
      maxOutputChars: 80,
    });
    const latencyMs = Date.now() - started;
    record({
      purpose: 'provider-test',
      provider: resolved.provider,
      model: resolved.model,
      status: 'success',
      latencyMs,
    });
    return {
      success: true,
      provider: resolved.provider,
      model: resolved.model,
      latencyMs,
      testPayload: 'generated-1x1-transparent-png',
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    record({
      purpose: 'provider-test',
      provider: resolved.provider,
      model: resolved.model,
      status: 'failure',
      latencyMs,
      errorCategory: 'provider-error',
    });
    return {
      success: false,
      provider: resolved.provider,
      model: resolved.model,
      latencyMs,
      testPayload: 'generated-1x1-transparent-png',
      error: sanitizeProviderError(error),
    };
  }
}

const TEXT_CAPABILITY_INSTRUCTIONS: Record<AITextCapability, string> = {
  translation: 'Translate the post while preserving meaning. Return only the translated text.',
  summarization: 'Summarize the post faithfully. Return only the summary.',
  cleanup: 'Clean up grammar and readability without changing meaning. Return only the rewritten text.',
  hashtags: 'Suggest relevant hashtags. Return only a short space-separated hashtag list.',
};

/** Fixed delivery order for opt-in text transforms. */
export const AI_TEXT_CAPABILITY_ORDER: readonly AITextCapability[] = [
  'cleanup',
  'translation',
  'summarization',
  'hashtags',
];

function normalizeHashtagList(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`))
    .filter((tag) => /^#[\p{L}\p{N}_]+$/u.test(tag));
}

async function runTextCapability(input: {
  capability: AITextCapability;
  text: string;
  overrides?: DestinationAIOverrides;
  client?: AIProviderClient;
  config?: AIConfig;
}): Promise<{ enabled: boolean; purpose: AITextCapability; output?: string }> {
  const aiConfig = input.config ?? getConfig().ai;
  const resolved = resolveAiProvider(aiConfig, input.overrides, input.capability);
  if (!resolved) return { enabled: false, purpose: input.capability };
  const client = input.client ?? createAIProviderClient(resolved);
  const started = Date.now();
  aiProviderUsageService.record({
    purpose: input.capability,
    provider: resolved.provider,
    model: resolved.model,
    status: 'request',
    latencyMs: 0,
  });
  try {
    const output = await client.complete({
      purpose: input.capability,
      prompt: `${TEXT_CAPABILITY_INSTRUCTIONS[input.capability]}\n\nPost:\n${input.text.slice(0, 5000)}`,
      maxOutputChars: 2000,
    });
    aiProviderUsageService.record({
      purpose: input.capability,
      provider: resolved.provider,
      model: resolved.model,
      status: 'success',
      latencyMs: Date.now() - started,
    });
    return { enabled: true, purpose: input.capability, output: output?.slice(0, 2000).trim() };
  } catch (error) {
    aiProviderUsageService.record({
      purpose: input.capability,
      provider: resolved.provider,
      model: resolved.model,
      status: 'failure',
      latencyMs: Date.now() - started,
      errorCategory: 'provider-error',
    });
    throw new Error(sanitizeProviderError(error));
  }
}

export async function previewTextCapability(input: {
  capability: AITextCapability;
  text: string;
  overrides?: DestinationAIOverrides;
  client?: AIProviderClient;
}): Promise<{ enabled: boolean; purpose: AITextCapability; output?: string }> {
  return runTextCapability(input);
}

export interface ApplyTextCapabilitiesResult {
  text: string;
  applied: AITextCapability[];
  failed: AITextCapability[];
}

/**
 * Apply enabled text capabilities in fixed order. Failures are logged by the
 * caller path via returned `failed` and never abort delivery.
 */
export async function applyTextCapabilities(
  text: string,
  options: {
    overrides?: DestinationAIOverrides;
    client?: AIProviderClient;
    config?: AIConfig;
  } = {},
): Promise<ApplyTextCapabilitiesResult> {
  let current = text;
  const applied: AITextCapability[] = [];
  const failed: AITextCapability[] = [];

  for (const capability of AI_TEXT_CAPABILITY_ORDER) {
    const resolved = resolveAiProvider(options.config ?? getConfig().ai, options.overrides, capability);
    if (!resolved) continue;
    try {
      const result = await runTextCapability({
        capability,
        text: current,
        overrides: options.overrides,
        client: options.client,
        config: options.config,
      });
      if (!result.enabled || !result.output) continue;
      if (capability === 'hashtags') {
        const tags = normalizeHashtagList(result.output);
        const missing = tags.filter((tag) => !current.toLowerCase().includes(tag.toLowerCase()));
        if (missing.length > 0) {
          current = `${current.trim()}\n\n${missing.join(' ')}`.trim();
          applied.push(capability);
        }
      } else {
        current = result.output;
        applied.push(capability);
      }
    } catch (error) {
      failed.push(capability);
      console.warn(
        `[ai] Text capability ${capability} failed; continuing with prior text:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { text: current, applied, failed };
}
