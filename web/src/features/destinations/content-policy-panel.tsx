import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { selectClassName } from '../../lib/dashboard-utils';
import { pickSelectedUsername } from './source-selection';
import type {
  AccountMapping,
  AIOverrideMode,
  ContentPolicyEditorState,
  DestinationAIOverrides,
  DuplicateSuppressionPolicy,
  ModerationPolicy,
  RoutingPolicy,
} from './types';

const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  includeKeywords: [],
  excludeKeywords: [],
  includeDomains: [],
  excludeDomains: [],
  contentTypes: [],
  mediaTypes: [],
  languages: [],
  allowedHours: [],
  timezone: 'UTC',
};

const DEFAULT_MODERATION_POLICY: ModerationPolicy = {
  blockKeywords: [],
  blockDomains: [],
  blockSourceUsernames: [],
  sensitiveContent: 'allow',
  dryRun: false,
};

const DEFAULT_DUPLICATE_SUPPRESSION: DuplicateSuppressionPolicy = {
  enabled: false,
  windowHours: 24,
  perceptualImageHash: false,
};

const DEFAULT_AI_OVERRIDES: DestinationAIOverrides = {
  imageAltText: 'inherit',
  textCapabilities: { translation: 'inherit', summarization: 'inherit', cleanup: 'inherit', hashtags: 'inherit' },
};

interface ContentPolicyPanelProps {
  mapping: AccountMapping;
  busy?: boolean;
  selectedUsername?: string;
  onSelectedUsernameChange?(username: string): void;
  onSave(payload: {
    moderationPolicy: ModerationPolicy;
    duplicateSuppression: DuplicateSuppressionPolicy;
    aiOverrides: AccountMapping['aiOverrides'];
    routeId?: string;
    routingPolicy?: RoutingPolicy;
    routeModerationPolicy?: ModerationPolicy;
    routeDuplicateSuppression?: DuplicateSuppressionPolicy;
  }): Promise<void>;
  onPreview(payload: {
    text: string;
    language?: string;
    sensitive?: boolean;
    routeId?: string;
    routingPolicy?: RoutingPolicy;
    moderationPolicy?: ModerationPolicy;
    routeModerationPolicy?: ModerationPolicy;
  }): Promise<{ allowed: boolean; reason: string; trace: unknown[] }>;
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function listValue(values: string[] | undefined): string {
  return (values ?? []).join(', ');
}

export function ContentPolicyPanel({
  mapping,
  busy,
  selectedUsername: preferredUsername,
  onSelectedUsernameChange,
  onSave,
  onPreview,
}: ContentPolicyPanelProps) {
  const sources = mapping.sources ?? [];
  const usernames = sources.map((source) => source.username);
  const initialUsername = pickSelectedUsername(usernames, undefined, preferredUsername);
  const initialSource = sources.find((source) => source.username === initialUsername) ?? sources[0];
  const initialRouteId = initialSource?.routeId ?? '';
  const [state, setState] = useState<ContentPolicyEditorState>(() => {
    const source = initialSource;
    return {
      username: source?.username ?? '',
      routeId: source?.routeId ?? '',
      routingPolicy: source?.routingPolicy ?? DEFAULT_ROUTING_POLICY,
      routeModerationPolicy: source?.moderationPolicy ?? mapping.moderationPolicy ?? DEFAULT_MODERATION_POLICY,
      routeDuplicateSuppression:
        source?.duplicateSuppression ?? mapping.duplicateSuppression ?? DEFAULT_DUPLICATE_SUPPRESSION,
      destinationModerationPolicy: mapping.moderationPolicy ?? DEFAULT_MODERATION_POLICY,
      destinationDuplicateSuppression: mapping.duplicateSuppression ?? DEFAULT_DUPLICATE_SUPPRESSION,
      aiOverrides: mapping.aiOverrides ?? DEFAULT_AI_OVERRIDES,
      previewText: '',
      previewLanguage: '',
      previewSensitive: false,
    };
  });

  const selectedSource = useMemo(
    () => sources.find((source) => source.routeId === state.routeId) ?? sources[0],
    [sources, state.routeId],
  );

  const selectRoute = (routeId: string, announce = true) => {
    const source = sources.find((entry) => entry.routeId === routeId);
    if (!source) return;
    setState((current) => ({
      ...current,
      username: source.username,
      routeId: source.routeId ?? '',
      routingPolicy: source.routingPolicy ?? current.routingPolicy,
      routeModerationPolicy: source.moderationPolicy ?? current.routeModerationPolicy,
      routeDuplicateSuppression: source.duplicateSuppression ?? current.routeDuplicateSuppression,
    }));
    if (announce) onSelectedUsernameChange?.(source.username);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: sync only when membership, revision, or focus changes
  useEffect(() => {
    const nextUsername = pickSelectedUsername(usernames, state.username, preferredUsername);
    const nextSource = sources.find((source) => source.username === nextUsername) ?? sources[0];
    if (!nextSource) {
      if (state.routeId || state.username) {
        setState((current) => ({ ...current, username: '', routeId: '' }));
      }
      return;
    }
    if (nextSource.routeId !== state.routeId || nextSource.username !== state.username) {
      selectRoute(nextSource.routeId ?? '', false);
    }
  }, [mapping.revision, mapping.updatedAt, usernames.join('\0'), preferredUsername]);

  return (
    <section className="space-y-4" aria-labelledby="content-policy-heading">
      <div>
        <h3 id="content-policy-heading" className="font-semibold">Moderation, routing, and dedup</h3>
        <p className="text-xs text-muted-foreground">
          Destination policies apply to every route. Route policies can further restrict delivery for one source.
        </p>
      </div>
      {sources.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="content-policy-route">Route</Label>
          <select
            id="content-policy-route"
            className={selectClassName}
            value={state.routeId || initialRouteId}
            onChange={(event) => selectRoute(event.target.value)}
          >
            {sources.map((source) => (
              <option key={`${source.username}-${source.routeId}`} value={source.routeId ?? ''}>
                @{source.username}
                {source.delivery?.mode === 'digest' ? ' (digest)' : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-semibold">Destination moderation</legend>
        <Label htmlFor="dest-block-keywords">Block keywords</Label>
        <Input
          id="dest-block-keywords"
          value={listValue(state.destinationModerationPolicy.blockKeywords)}
          onChange={(event) =>
            setState((current) => ({
              ...current,
              destinationModerationPolicy: {
                ...current.destinationModerationPolicy,
                blockKeywords: splitList(event.target.value),
              },
            }))
          }
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.destinationModerationPolicy.dryRun}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                destinationModerationPolicy: {
                  ...current.destinationModerationPolicy,
                  dryRun: event.target.checked,
                },
              }))
            }
          />
          Dry-run moderation (trace only, do not block)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.destinationDuplicateSuppression.enabled}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                destinationDuplicateSuppression: {
                  ...current.destinationDuplicateSuppression,
                  enabled: event.target.checked,
                },
              }))
            }
          />
          Suppress duplicate posts
        </label>
      </fieldset>

      {selectedSource ? (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-semibold">Route routing for @{selectedSource.username}</legend>
          <Label htmlFor="route-include-keywords">Include keywords</Label>
          <Input
            id="route-include-keywords"
            value={listValue(state.routingPolicy.includeKeywords)}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                routingPolicy: { ...current.routingPolicy, includeKeywords: splitList(event.target.value) },
              }))
            }
          />
          <Label htmlFor="route-exclude-keywords">Exclude keywords</Label>
          <Input
            id="route-exclude-keywords"
            value={listValue(state.routingPolicy.excludeKeywords)}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                routingPolicy: { ...current.routingPolicy, excludeKeywords: splitList(event.target.value) },
              }))
            }
          />
        </fieldset>
      ) : null}

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-semibold">Policy preview</legend>
        <Label htmlFor="policy-preview-text">Sample text</Label>
        <textarea
          id="policy-preview-text"
          className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={state.previewText}
          onChange={(event) => setState((current) => ({ ...current, previewText: event.target.value }))}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !state.previewText.trim()}
            onClick={() => {
              void onPreview({
                text: state.previewText,
                language: state.previewLanguage || undefined,
                sensitive: state.previewSensitive,
                routeId: state.routeId || undefined,
                routingPolicy: state.routingPolicy,
                moderationPolicy: state.destinationModerationPolicy,
                routeModerationPolicy: state.routeModerationPolicy,
              }).then((result) => setState((current) => ({ ...current, previewResult: result })));
            }}
          >
            Preview policy
          </Button>
          {state.previewResult ? (
            <output
              className={`block text-sm ${state.previewResult.allowed ? 'text-emerald-700' : 'text-red-600'}`}
            >
              {state.previewResult.allowed ? 'Allowed' : 'Blocked'}: {state.previewResult.reason}
            </output>
          ) : null}
        </div>
      </fieldset>

      <Button
        type="button"
        disabled={busy}
        onClick={() =>
          void onSave({
            moderationPolicy: state.destinationModerationPolicy,
            duplicateSuppression: state.destinationDuplicateSuppression,
            aiOverrides: state.aiOverrides,
            routeId: state.routeId || undefined,
            routingPolicy: state.routingPolicy,
            routeModerationPolicy: state.routeModerationPolicy,
            routeDuplicateSuppression: state.routeDuplicateSuppression,
          })
        }
      >
        Save content policies
      </Button>
      {/* Keep AIOverrideMode referenced for future section wiring. */}
      <span className="hidden">{null as unknown as AIOverrideMode}</span>
    </section>
  );
}
