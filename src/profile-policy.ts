import type { AccountMapping, ProfileFieldPolicy, SyncMode } from './config/schemas.js';
import { normalizeTwitterUsername } from './mapping-helpers.js';

export type ProfileMutationAction =
  | 'profile-preview'
  | 'profile-apply'
  | 'profile-sync-scheduled'
  | 'bot-label'
  | 'display-name-suffix'
  | 'pin-sync-manual'
  | 'pin-sync-scheduled';

export interface ProfileMutationDecision {
  allowed: boolean;
  action: ProfileMutationAction;
  reason?: string;
  sourceUsername?: string;
  fields?: ProfileFieldPolicy;
}

const hasSelectedField = (fields: ProfileFieldPolicy): boolean =>
  fields.displayName || fields.description || fields.avatar || fields.banner;

const modeAllowsManualMutation = (mode: SyncMode): boolean => mode === 'manual' || mode === 'scheduled';

export function resolvePolicySource(
  mapping: Pick<AccountMapping, 'twitterUsernames'>,
  configuredSource?: unknown,
  requestedSource?: unknown,
): string | undefined {
  const sources = [
    ...new Set(
      mapping.twitterUsernames
        .map(normalizeTwitterUsername)
        .filter((username): username is string => Boolean(username)),
    ),
  ];
  const requested = normalizeTwitterUsername(requestedSource);
  if (requested) {
    return sources.includes(requested) ? requested : undefined;
  }
  const configured = normalizeTwitterUsername(configuredSource);
  if (configured) {
    return sources.includes(configured) ? configured : undefined;
  }
  return sources.length === 1 ? sources[0] : undefined;
}

export function resolveProfilePolicySource(
  mapping: AccountMapping,
  requestedSource?: unknown,
): string | undefined {
  return resolvePolicySource(mapping, mapping.profileManagement.profileSync.sourceUsername, requestedSource);
}

export function resolvePinPolicySource(mapping: AccountMapping, requestedSource?: unknown): string | undefined {
  return resolvePolicySource(mapping, mapping.profileManagement.pinSync.sourceUsername, requestedSource);
}

export function evaluateProfileMutation(
  mapping: AccountMapping,
  action: ProfileMutationAction,
  options: {
    requestedSource?: unknown;
    requestedFields?: Partial<ProfileFieldPolicy>;
  } = {},
): ProfileMutationDecision {
  const policy = mapping.profileManagement;

  if (action === 'profile-preview') {
    const sourceUsername = resolveProfilePolicySource(mapping, options.requestedSource);
    return sourceUsername
      ? { allowed: true, action, sourceUsername, fields: { ...policy.profileSync.fields } }
      : { allowed: false, action, reason: 'Select a valid profile source for this destination.' };
  }

  if (!policy.allowProfileMutation) {
    return { allowed: false, action, reason: 'Profile mutation is disabled for this destination.' };
  }

  if (action === 'bot-label') {
    return policy.ensureBotLabel
      ? { allowed: true, action }
      : { allowed: false, action, reason: 'Bot self-label mutation is not enabled for this destination.' };
  }

  if (action === 'display-name-suffix') {
    return policy.ensureDisplayNameBotSuffix
      ? { allowed: true, action }
      : { allowed: false, action, reason: 'Display-name suffix mutation is not enabled for this destination.' };
  }

  if (action === 'pin-sync-manual' || action === 'pin-sync-scheduled') {
    const modeAllowed =
      action === 'pin-sync-scheduled'
        ? policy.pinSync.mode === 'scheduled'
        : modeAllowsManualMutation(policy.pinSync.mode);
    if (!modeAllowed) {
      return {
        allowed: false,
        action,
        reason:
          action === 'pin-sync-scheduled'
            ? 'Scheduled pin synchronization is not enabled for this destination.'
            : 'Manual pin synchronization is not enabled for this destination.',
      };
    }
    const sourceUsername = resolvePinPolicySource(mapping, options.requestedSource);
    return sourceUsername
      ? { allowed: true, action, sourceUsername }
      : { allowed: false, action, reason: 'Select a valid pin source for this destination.' };
  }

  const modeAllowed =
    action === 'profile-sync-scheduled'
      ? policy.profileSync.mode === 'scheduled'
      : modeAllowsManualMutation(policy.profileSync.mode);
  if (!modeAllowed) {
    return {
      allowed: false,
      action,
      reason:
        action === 'profile-sync-scheduled'
          ? 'Scheduled profile synchronization is not enabled for this destination.'
          : 'Manual profile synchronization is not enabled for this destination.',
    };
  }

  const sourceUsername = resolveProfilePolicySource(mapping, options.requestedSource);
  if (!sourceUsername) {
    return { allowed: false, action, reason: 'Select a valid profile source for this destination.' };
  }

  const requested = options.requestedFields;
  const fields: ProfileFieldPolicy = requested
    ? {
        displayName: requested.displayName === true && policy.profileSync.fields.displayName,
        description: requested.description === true && policy.profileSync.fields.description,
        avatar: requested.avatar === true && policy.profileSync.fields.avatar,
        banner: requested.banner === true && policy.profileSync.fields.banner,
      }
    : { ...policy.profileSync.fields };

  if (!hasSelectedField(fields)) {
    return { allowed: false, action, reason: 'No explicitly enabled profile fields were selected.' };
  }

  return { allowed: true, action, sourceUsername, fields };
}

export function assertProfileMutationAllowed(
  mapping: AccountMapping,
  action: ProfileMutationAction,
  options?: {
    requestedSource?: unknown;
    requestedFields?: Partial<ProfileFieldPolicy>;
  },
): ProfileMutationDecision & { allowed: true } {
  const decision = evaluateProfileMutation(mapping, action, options);
  if (!decision.allowed) {
    throw new Error(decision.reason || 'Profile mutation is not allowed.');
  }
  return decision as ProfileMutationDecision & { allowed: true };
}
