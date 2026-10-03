import { createHash } from 'node:crypto';
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
  return encodeTid(BigInt(Math.floor(createdAtMs)) * 1000n + BigInt(microsWithinMs), clockId);
}

export interface PostRecordClient {
  create(
    params: { repo: string; rkey: string },
    record: Record<string, unknown>,
  ): Promise<{ uri: string; cid: string }>;
  get(params: { repo: string; rkey: string }): Promise<{ cid?: string; value: unknown }>;
}

/** A create that may have failed because the key already holds a record. */
function mayBeExistingRecord(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 400 || status === 409) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /already|exists/i.test(message);
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
    if (!recoveredRecordMatches(existing.value, record)) {
      throw new Error(
        `Refusing to adopt the existing record at rkey ${rkey}: its content does not match the post being delivered.`,
      );
    }
    return { uri: `at://${repo}/app.bsky.feed.post/${rkey}`, cid: String(existing.cid) };
  }
}
