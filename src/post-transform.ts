import type { AttributionPolicy, PostingPolicy } from './config/schemas.js';
import { normalizeTwitterUsername } from './mapping-helpers.js';

export const ALLOWED_ATTRIBUTION_TEMPLATE_VARIABLES = ['username', 'url', 'postUrl', 'destination'] as const;

export interface PostTransformContext {
  twitterUsername: string;
  tweetId: string;
  originalPostUrl: string;
  destinationIdentifier: string;
  sourceCount: number;
  isReply: boolean;
  isThreadRoot: boolean;
}

export interface LinkFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: Array<{
    $type: 'app.bsky.richtext.facet#link';
    uri: string;
  }>;
}

export interface PostTransformResult {
  text: string;
  facets: LinkFacet[];
  attributionApplied: boolean;
  originalLinkApplied: boolean;
}

const templateVariablePattern = /\{([^{}]+)\}/g;

const utf8Offset = (text: string, utf16Index: number): number => Buffer.byteLength(text.slice(0, utf16Index), 'utf8');

export function validateAttributionTemplate(template: string): void {
  if (typeof template !== 'string' || template.length < 1 || template.length > 160) {
    throw new Error('Attribution template must contain between 1 and 160 characters.');
  }
  const allowed = new Set<string>(ALLOWED_ATTRIBUTION_TEMPLATE_VARIABLES);
  for (const match of template.matchAll(templateVariablePattern)) {
    const variable = match[1] || '';
    if (!allowed.has(variable)) {
      throw new Error(`Attribution template contains unsupported variable: {${variable}}.`);
    }
  }
  if (template.replace(templateVariablePattern, '').includes('{') || template.replace(templateVariablePattern, '').includes('}')) {
    throw new Error('Attribution template contains an invalid variable expression.');
  }
}

export function shouldApplyAttribution(
  policy: AttributionPolicy,
  sourceCount: number,
  isThreadRoot: boolean,
): boolean {
  if (policy.rootPostsOnly && !isThreadRoot) {
    return false;
  }
  switch (policy.mode) {
    case 'always':
      return true;
    case 'multiple-sources':
      return sourceCount > 1;
    case 'never':
      return false;
  }
  return false;
}

interface RenderedAttribution {
  text: string;
  sourceRange?: { start: number; end: number };
}

export function renderAttributionTemplate(template: string, context: PostTransformContext): RenderedAttribution {
  validateAttributionTemplate(template);
  const username = normalizeTwitterUsername(context.twitterUsername) || context.twitterUsername.trim().replace(/^@/, '');
  const values: Record<(typeof ALLOWED_ATTRIBUTION_TEMPLATE_VARIABLES)[number], string> = {
    username,
    url: `https://x.com/${username}`,
    postUrl: context.originalPostUrl,
    destination: context.destinationIdentifier,
  };

  let output = '';
  let cursor = 0;
  let sourceRange: RenderedAttribution['sourceRange'];
  for (const match of template.matchAll(templateVariablePattern)) {
    const index = match.index ?? 0;
    output += template.slice(cursor, index);
    const variable = match[1] as keyof typeof values;
    const replacement = values[variable];
    const start = output.length;
    output += replacement;
    if (!sourceRange && (variable === 'username' || variable === 'url')) {
      const includeAt = variable === 'username' && start > 0 && output[start - 1] === '@';
      sourceRange = { start: includeAt ? start - 1 : start, end: output.length };
    }
    cursor = index + match[0].length;
  }
  output += template.slice(cursor);
  return { text: output, sourceRange };
}

export function applyPostingPolicy(
  inputText: string,
  policy: PostingPolicy,
  context: PostTransformContext,
): PostTransformResult {
  const originalText = inputText.trim();
  let text = originalText;
  const facets: LinkFacet[] = [];
  let attributionApplied = false;
  let originalLinkApplied = false;

  if (shouldApplyAttribution(policy.attribution, context.sourceCount, context.isThreadRoot)) {
    const rendered = renderAttributionTemplate(policy.attribution.template, context);
    text = `${rendered.text}\n\n${text}`.trim();
    attributionApplied = true;
    if (policy.attribution.linkSource && rendered.sourceRange) {
      facets.push({
        index: {
          byteStart: utf8Offset(text, rendered.sourceRange.start),
          byteEnd: utf8Offset(text, rendered.sourceRange.end),
        },
        features: [
          {
            $type: 'app.bsky.richtext.facet#link',
            uri: `https://x.com/${normalizeTwitterUsername(context.twitterUsername) || context.twitterUsername}`,
          },
        ],
      });
    }
  }

  if (policy.appendOriginalPostLink && context.originalPostUrl && !text.includes(context.originalPostUrl)) {
    text = `${text}\n\n${context.originalPostUrl}`.trim();
    originalLinkApplied = true;
  }

  return { text, facets, attributionApplied, originalLinkApplied };
}

const getGraphemeBoundaries = (value: string): number[] => {
  const Segmenter = Intl.Segmenter;
  const boundaries = [0];
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const segment of segmenter.segment(value)) {
      boundaries.push(segment.index + segment.segment.length);
    }
    return [...new Set(boundaries)];
  }
  let index = 0;
  for (const character of Array.from(value)) {
    index += character.length;
    boundaries.push(index);
  }
  return boundaries;
};

const graphemeCount = (value: string): number => Math.max(0, getGraphemeBoundaries(value).length - 1);

const chooseSplitIndex = (value: string, maxGraphemes: number): number => {
  const boundaries = getGraphemeBoundaries(value);
  const hardBoundary = boundaries[Math.min(maxGraphemes, boundaries.length - 1)] ?? value.length;
  const prefix = value.slice(0, hardBoundary);
  const paragraph = prefix.lastIndexOf('\n\n');
  if (paragraph > 0) return paragraph;
  const sentences = [...prefix.matchAll(/[.!?]\s/g)];
  const sentence = sentences[sentences.length - 1];
  if (sentence?.index !== undefined && sentence.index > 0) return sentence.index + 1;
  const whitespace = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'), prefix.lastIndexOf('\t'));
  return whitespace > 0 ? whitespace : hardBoundary;
};

export function splitPostText(text: string, limit = 300): string[] {
  if (!Number.isInteger(limit) || limit < 10) {
    throw new Error('Post text limit must be a whole number of at least 10.');
  }
  const normalized = text.trim();
  if (graphemeCount(normalized) <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  const effectiveLimit = limit - 8;
  while (remaining.length > 0) {
    if (graphemeCount(remaining) <= effectiveLimit) {
      chunks.push(remaining);
      break;
    }
    const splitIndex = chooseSplitIndex(remaining, effectiveLimit);
    const chunk = remaining.slice(0, splitIndex).trim();
    remaining = remaining.slice(splitIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

export function facetsForFirstChunk(facets: LinkFacet[], chunk: string, chunkIndex: number): LinkFacet[] {
  if (chunkIndex !== 0) return [];
  const byteLength = Buffer.byteLength(chunk, 'utf8');
  return facets.filter((facet) => facet.index.byteStart >= 0 && facet.index.byteEnd <= byteLength);
}

/** @deprecated Use applyPostingPolicy so preview and delivery share policy behavior. */
export function applyCurrentSourceAttribution(text: string, twitterUsername: string, isReply: boolean): string {
  return applyPostingPolicy(
    text,
    {
      attribution: {
        mode: 'always',
        template: 'Source: @{username} on X',
        rootPostsOnly: true,
        linkSource: true,
      },
      appendOriginalPostLink: false,
    },
    {
      twitterUsername,
      tweetId: '',
      originalPostUrl: '',
      destinationIdentifier: '',
      sourceCount: 1,
      isReply,
      isThreadRoot: !isReply,
    },
  ).text;
}
