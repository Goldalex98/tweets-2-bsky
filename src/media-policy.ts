/** Bluesky rejects image alt text longer than this many graphemes. */
export const ALT_TEXT_MAX_GRAPHEMES = 2000;
/** Bluesky post text limit, in graphemes. */
export const POST_TEXT_MAX_GRAPHEMES = 300;

const graphemes = (value: string): string[] =>
  Intl.Segmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((entry) => entry.segment)
    : Array.from(value);

/**
 * Alt text for an uploaded image: trimmed and capped at Bluesky's limit. With
 * none available it stays empty, which screen readers treat as "no
 * description" instead of reading out a meaningless placeholder.
 */
export function normalizeAltText(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  const parts = graphemes(trimmed);
  if (parts.length <= ALT_TEXT_MAX_GRAPHEMES) return trimmed;
  return `${parts
    .slice(0, ALT_TEXT_MAX_GRAPHEMES - 1)
    .join('')
    .trimEnd()}…`;
}

const isVideo = (media: { type?: string }): boolean => media.type === 'video' || media.type === 'animated_gif';

/**
 * Upload order for a post's media. A post carries either one video or up to
 * four images, and a video wins, so it is tried first: photos are uploaded
 * only when there is no video or the video fell back to a link.
 */
export function orderMediaForUpload<T extends { type?: string }>(media: readonly T[]): T[] {
  return [...media.filter(isVideo), ...media.filter((entry) => !isVideo(entry))];
}

/**
 * True when the post text is over the limit only because of a link that the
 * link card will carry anyway, so dropping it avoids splitting into a thread.
 */
export function shouldDropCardLinkFromText(
  text: string,
  link: string,
  maxGraphemes = POST_TEXT_MAX_GRAPHEMES,
): boolean {
  if (!text.includes(link)) return false;
  if (graphemes(text).length <= maxGraphemes) return false;
  return graphemes(text.replace(link, '').trim()).length <= maxGraphemes;
}
