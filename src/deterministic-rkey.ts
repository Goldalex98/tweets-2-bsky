import { createHash } from 'node:crypto';
import { BSKY_AUTH_ERROR_CODES } from './observability.js';
import { recoveredRecordMatches } from './pipeline/delivery-policy.js';

const S32_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
const MICROS_MASK = (1n << 53n) - 1n;

/** Encodes a TID: 53 bits of microseconds and a 10-bit clock id, base32-sortable. */
export function encodeTid(timestampMicros: bigint, clockId: number): string {
  let value = ((timestampMicros & MICROS_MASK) << 10n) | BigInt(clockId & 0x3ff);
  let encoded = '';
  for (let index = 0; index < 13; index += 1) {
    encoded = `${S32_ALPHABET[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

/**
 * A record key that is the same on every retry of one chunk, so a post that
 * landed but timed out is found again instead of posted twice. Posts must use
 * TID keys, so the key is a TID at the record's createdAt, with the sub-
 * millisecond digits and clock id taken from a hash of the delivery identity.
 * The chunk index is added in milliseconds, so the chunks of one post never
 * share a millisecond and their keys sort in thread order.
 */
export function deterministicPostRkey(
  destinationId: string,
  externalPostId: string,
  chunkIndex: number,
  createdAtMs: number,
): string {
  const hash = createHash('sha256').update(`${destinationId}\0${externalPostId}\0${chunkIndex}`).digest();
  const microsWithinMs = hash.readUInt16BE(0) % 1000;
  const clockId = hash.readUInt16BE(2) & 0x3ff;
  const timestampMs = BigInt(Math.floor(createdAtMs) + chunkIndex);
  return encodeTid(timestampMs * 1000n + BigInt(microsWithinMs), clockId);
}

/**
 * The key holds a different record. Retrying cannot change that, so the post
 * loop stops at once and the queue parks the delivery for an operator.
 */
export class RkeyConflictError extends Error {
  override readonly name = 'RkeyConflictError';
}

export interface PostRecordClient {
  create(
    params: { repo: string; rkey: string },
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }>;
  get(params: { repo: string; rkey: string }): Promise<{ cid?: string; value: unknown }>;
}

/**
 * A create that may have failed because the key already holds a record. Auth
 * and rate-limit failures are passed through untouched so their classifiers
 * see them; anything else that could be a taken key is checked by reading it.
 */
function mayBeExistingRecord(error: unknown): boolean {
  const { status, error: code } = (error ?? {}) as { status?: unknown; error?: unknown };
  if (typeof code === 'string' && (BSKY_AUTH_ERROR_CODES.has(code) || code === 'RateLimitExceeded')) return false;
  if (status === 400 || status === 409 || (typeof status === 'number' && status >= 500)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|record exists/i.test(message);
}

/** The text and reply target must both match before a record is adopted. */
function sameReplyParent(existing: unknown, intended: Record<string, unknown>): boolean {
  const parentUri = (value: unknown): unknown =>
    (value as { reply?: { parent?: { uri?: unknown } } } | null)?.reply?.parent?.uri;
  return parentUri(existing) === parentUri(intended);
}

/**
 * Creates the post at `rkey`. When the key is already taken, adopts the
 * existing record only if its text matches; a different record is never
 * claimed as this delivery's post.
 */
export async function createPostAtRkey(
  posts: PostRecordClient,
  repo: string,
  rkey: string,
  record: Record<string, unknown>,
): Promise<{ uri: string; cid: string }> {
  try {
    const created = await posts.create({ repo, rkey }, record);
    return { uri: created.uri, cid: created.cid };
  } catch (error) {
    if (!mayBeExistingRecord(error)) throw error;
    let existing: { cid?: string; value: unknown };
    try {
      existing = await posts.get({ repo, rkey });
    } catch {
      throw error;
    }
    if (!existing.cid) throw error;
    if (!recoveredRecordMatches(existing.value, record) || !sameReplyParent(existing.value, record)) {
      throw new RkeyConflictError(
        `Refusing to adopt the existing record at rkey ${rkey}: its content does not match the post being delivered.`,
        { cause: error },
      );
    }
    return { uri: `at://${repo}/app.bsky.feed.post/${rkey}`, cid: String(existing.cid) };
  }
}
