import { managedBlueskyFetch } from '../services/bluesky-mutation-guard.js';

export const VIDEO_UPLOAD_TIMEOUT_MS = 45 * 60 * 1000;

/** Re-check managed-account health after service authentication, before upload. */
export function fetchBlueskyVideoUpload(
  identity: { did: string; serviceUrl: string },
  url: URL,
  init: RequestInit,
): Promise<Response> {
  return managedBlueskyFetch(
    { bskyIdentifier: identity.did, bskyServiceUrl: identity.serviceUrl },
    VIDEO_UPLOAD_TIMEOUT_MS,
  )(url, init);
}
