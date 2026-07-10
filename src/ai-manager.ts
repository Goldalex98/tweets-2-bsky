import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { getConfig } from './config-manager.js';

interface ResolvedAiProvider {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

// Determine Provider and Credentials.
// Priority: AI Config > Legacy Gemini Config > Environment Variables.
// Returns null when alt-text generation is effectively disabled (no usable credentials).
function resolveAiProvider(): ResolvedAiProvider | null {
  const config = getConfig();

  const provider = config.ai?.provider || 'gemini';
  let apiKey = config.ai?.apiKey;
  let model = config.ai?.model;
  const baseUrl = config.ai?.baseUrl;

  // Fallbacks for Environment Variables
  if (!apiKey) {
    if (process.env.AI_API_KEY) apiKey = process.env.AI_API_KEY;
    else if (provider === 'gemini') apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
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
export function isAltTextConfigured(): boolean {
  return resolveAiProvider() !== null;
}

export async function generateAltText(
  buffer: Buffer,
  mimeType: string,
  contextText: string,
): Promise<string | undefined> {
  const resolved = resolveAiProvider();
  if (!resolved) {
    return undefined;
  }
  const { provider, apiKey, model, baseUrl } = resolved;

  try {
    const prompt = buildAltTextPrompt(contextText);
    switch (provider) {
      case 'gemini':
        // apiKey is guaranteed by check above
        return normalizeAltTextOutput(
          await callGemini(apiKey!, model || 'models/gemini-2.5-flash', buffer, mimeType, prompt),
        );
      case 'openai':
      case 'custom':
        return normalizeAltTextOutput(
          await callOpenAICompatible(apiKey, model || 'gpt-4o', baseUrl, buffer, mimeType, prompt),
        );
      case 'anthropic':
        // apiKey is guaranteed by check above
        return normalizeAltTextOutput(
          await callAnthropic(apiKey!, model || 'claude-3-5-sonnet-20241022', baseUrl, buffer, mimeType, prompt),
        );
      default:
        console.warn(`[AI] ⚠️ Unknown provider: ${provider}`);
        return undefined;
    }
  } catch (err) {
    console.warn(`[AI] ⚠️ Failed to generate alt text with ${provider}: ${(err as Error).message}`);
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

function normalizeAltTextOutput(output: string | undefined): string | undefined {
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

  return cleaned || undefined;
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
