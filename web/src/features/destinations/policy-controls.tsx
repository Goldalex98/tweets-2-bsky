import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  ATTRIBUTION_MODE_OPTIONS,
  describeAttribution,
  selectClassName,
  validateAttributionTemplate,
} from '../../lib/dashboard-utils';
import type { AIOverrideMode, AttributionMode, MappingFormState, SyncMode } from './types';

interface PolicyFieldsProps {
  idPrefix: string;
  form: MappingFormState;
  sourceCount: number;
  sourceUsernames?: string[];
  onFormChange(update: (current: MappingFormState) => MappingFormState): void;
}

interface PostingPreviewProps {
  idPrefix: string;
  form: MappingFormState;
  sourceUsernames: string[];
  busy?: boolean;
  onPreview(input: {
    text: string;
    twitterUsername?: string;
    postingPolicy: MappingFormState['postingPolicy'];
  }): Promise<{ text: string; attributionApplied: boolean; originalLinkApplied: boolean }>;
}

interface ProfileSyncActionsProps {
  form: MappingFormState;
  busy?: boolean;
  onPreviewProfile(): void;
  onApplyProfile(): void;
  onQueuePinSync(): void;
}

export function AttributionPolicyFields({ idPrefix, form, sourceCount, onFormChange }: PolicyFieldsProps) {
  const attribution = form.postingPolicy.attribution;
  const templateError = validateAttributionTemplate(attribution.template);
  const modeId = `${idPrefix}-attribution-mode`;
  const templateId = `${idPrefix}-attribution-template`;
  const templateHintId = `${idPrefix}-attribution-template-hint`;

  const updateAttribution = (patch: Partial<MappingFormState['postingPolicy']['attribution']>) =>
    onFormChange((current) => ({
      ...current,
      postingPolicy: {
        ...current.postingPolicy,
        attribution: { ...current.postingPolicy.attribution, ...patch },
      },
    }));

  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-semibold">Source attribution</legend>
      <p className="text-xs text-muted-foreground">
        Controls whether each mirrored post is prefixed with the X username it came from. Aggregate destinations
        normally need it; one-to-one mirrors normally do not.
      </p>
      <div className="space-y-1">
        <Label htmlFor={modeId}>Prepend the X username</Label>
        <select
          id={modeId}
          className={selectClassName}
          value={attribution.mode}
          onChange={(event) => updateAttribution({ mode: event.target.value as AttributionMode })}
        >
          {ATTRIBUTION_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-attribution-summary`}>
          {describeAttribution(attribution.mode, sourceCount)}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={templateId}>Attribution template</Label>
        <Input
          id={templateId}
          value={attribution.template}
          maxLength={160}
          aria-describedby={templateHintId}
          aria-invalid={templateError ? true : undefined}
          onChange={(event) => updateAttribution({ template: event.target.value })}
        />
        <p id={templateHintId} className={`text-xs ${templateError ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`} role={templateError ? 'alert' : undefined}>
          {templateError ?? 'Available variables: {username}, {url}, {postUrl}, {destination}.'}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          checked={attribution.rootPostsOnly}
          onChange={(event) => updateAttribution({ rootPostsOnly: event.target.checked })}
        />
        Only attribute the first post of a thread
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          checked={attribution.linkSource}
          onChange={(event) => updateAttribution({ linkSource: event.target.checked })}
        />
        Link the X source in the attribution line
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          checked={form.postingPolicy.appendOriginalPostLink}
          onChange={(event) =>
            onFormChange((current) => ({
              ...current,
              postingPolicy: { ...current.postingPolicy, appendOriginalPostLink: event.target.checked },
            }))
          }
        />
        Append a link back to the original X post
      </label>
    </fieldset>
  );
}

export function PostingPolicyPreview({ idPrefix, form, sourceUsernames, busy, onPreview }: PostingPreviewProps) {
  const [sampleText, setSampleText] = useState('Example post about the new release.');
  const [username, setUsername] = useState(sourceUsernames[0] || 'source');
  const [result, setResult] = useState<{ text: string; attributionApplied: boolean; originalLinkApplied: boolean } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  return (
    <fieldset className="space-y-3 rounded-md border p-4" data-testid={`${idPrefix}-posting-preview`}>
      <legend className="px-1 text-sm font-semibold">Preview sample post</legend>
      <p className="text-xs text-muted-foreground">
        Uses the draft attribution policy above. Does not enqueue or post.
      </p>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-preview-username`}>Sample source username</Label>
        <select
          id={`${idPrefix}-preview-username`}
          className={selectClassName}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        >
          {(sourceUsernames.length > 0 ? sourceUsernames : ['source']).map((entry) => (
            <option key={entry} value={entry}>@{entry}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-preview-text`}>Sample text</Label>
        <Input
          id={`${idPrefix}-preview-text`}
          value={sampleText}
          onChange={(event) => setSampleText(event.target.value)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || previewBusy}
        onClick={() => {
          setPreviewBusy(true);
          void onPreview({
            text: sampleText,
            twitterUsername: username,
            postingPolicy: form.postingPolicy,
          })
            .then((preview) => setResult(preview))
            .finally(() => setPreviewBusy(false));
        }}
      >
        {previewBusy ? 'Previewing…' : 'Preview transformed text'}
      </Button>
      {result ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid={`${idPrefix}-posting-preview-result`}>
          <p className="whitespace-pre-wrap">{result.text}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Attribution: {result.attributionApplied ? 'applied' : 'not applied'}; original link:{' '}
            {result.originalLinkApplied ? 'applied' : 'not applied'}
          </p>
        </div>
      ) : null}
    </fieldset>
  );
}

export function ProfileMutationField({
  idPrefix,
  form,
  sourceUsernames = [],
  onFormChange,
}: Omit<PolicyFieldsProps, 'sourceCount'>) {
  const checkboxId = `${idPrefix}-allow-profile-mutation`;
  const descriptionId = `${idPrefix}-allow-profile-mutation-description`;
  const allowed = form.profileManagement.allowProfileMutation;
  const profileSync = form.profileManagement.profileSync;
  const pinSync = form.profileManagement.pinSync;

  const updateProfileManagement = (patch: Partial<MappingFormState['profileManagement']>) =>
    onFormChange((current) => ({
      ...current,
      profileManagement: { ...current.profileManagement, ...patch },
    }));

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-3 text-sm">
        <div>
          <Label htmlFor={checkboxId} className="text-sm font-semibold text-foreground">
            Allow Bluesky profile mutation
          </Label>
          <span id={descriptionId} className="mt-1 block text-xs text-muted-foreground">
            {allowed
              ? 'Profile, bot label, and pin changes become possible once a sync mode is also enabled. Adding sources and validating credentials still never touch the profile.'
              : 'Off: adding sources, validating credentials, and posting never change the Bluesky profile, label, or pins.'}
          </span>
        </div>
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-describedby={descriptionId}
          checked={allowed}
          onChange={(event) =>
            updateProfileManagement({ allowProfileMutation: event.target.checked })
          }
        />
      </div>
      {allowed ? (
        <div className="space-y-4 border-t pt-3" data-testid={`${idPrefix}-profile-sync-controls`}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-foreground"
              checked={form.profileManagement.ensureBotLabel}
              onChange={(event) => updateProfileManagement({ ensureBotLabel: event.target.checked })}
            />
            Ensure bot label
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-foreground"
              checked={form.profileManagement.ensureDisplayNameBotSuffix}
              onChange={(event) => updateProfileManagement({ ensureDisplayNameBotSuffix: event.target.checked })}
            />
            Ensure display-name bot suffix
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-profile-sync-mode`}>Profile sync mode</Label>
              <select
                id={`${idPrefix}-profile-sync-mode`}
                className={selectClassName}
                value={profileSync.mode}
                onChange={(event) =>
                  updateProfileManagement({
                    profileSync: { ...profileSync, mode: event.target.value as SyncMode },
                  })
                }
              >
                <option value="off">Off</option>
                <option value="manual">Manual</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-pin-sync-mode`}>Pin sync mode</Label>
              <select
                id={`${idPrefix}-pin-sync-mode`}
                className={selectClassName}
                value={pinSync.mode}
                onChange={(event) =>
                  updateProfileManagement({
                    pinSync: { ...pinSync, mode: event.target.value as SyncMode },
                  })
                }
              >
                <option value="off">Off</option>
                <option value="manual">Manual</option>
                <option value="scheduled">Scheduled</option>
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-profile-sync-source`}>Profile sync source</Label>
            <select
              id={`${idPrefix}-profile-sync-source`}
              className={selectClassName}
              value={profileSync.sourceUsername || ''}
              onChange={(event) =>
                updateProfileManagement({
                  profileSync: { ...profileSync, sourceUsername: event.target.value || undefined },
                })
              }
            >
              <option value="">Select source…</option>
              {sourceUsernames.map((username) => (
                <option key={username} value={username}>@{username}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-pin-sync-source`}>Pin sync source</Label>
            <select
              id={`${idPrefix}-pin-sync-source`}
              className={selectClassName}
              value={pinSync.sourceUsername || ''}
              onChange={(event) =>
                updateProfileManagement({
                  pinSync: { ...pinSync, sourceUsername: event.target.value || undefined },
                })
              }
            >
              <option value="">Select source…</option>
              {sourceUsernames.map((username) => (
                <option key={username} value={username}>@{username}</option>
              ))}
            </select>
          </div>
          {profileSync.mode === 'scheduled' ? (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-profile-sync-interval`}>Profile sync interval (hours)</Label>
              <Input
                id={`${idPrefix}-profile-sync-interval`}
                type="number"
                min={1}
                max={168}
                value={profileSync.intervalHours}
                onChange={(event) =>
                  updateProfileManagement({
                    profileSync: {
                      ...profileSync,
                      intervalHours: Math.max(1, Number(event.target.value) || 1),
                    },
                  })
                }
              />
            </div>
          ) : null}
          {pinSync.mode === 'scheduled' ? (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-pin-sync-interval`}>Pin sync interval (hours)</Label>
              <Input
                id={`${idPrefix}-pin-sync-interval`}
                type="number"
                min={1}
                max={168}
                value={pinSync.intervalHours}
                onChange={(event) =>
                  updateProfileManagement({
                    pinSync: {
                      ...pinSync,
                      intervalHours: Math.max(1, Number(event.target.value) || 1),
                    },
                  })
                }
              />
            </div>
          ) : null}
          {profileSync.mode !== 'off' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(['displayName', 'description', 'avatar', 'banner'] as const).map((field) => (
                <label key={field} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-foreground"
                    checked={profileSync.fields[field]}
                    onChange={(event) =>
                      updateProfileManagement({
                        profileSync: {
                          ...profileSync,
                          fields: { ...profileSync.fields, [field]: event.target.checked },
                        },
                      })
                    }
                  />
                  Sync {field}
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DestinationAiOverridesFields({
  idPrefix,
  form,
  onFormChange,
}: Omit<PolicyFieldsProps, 'sourceCount' | 'sourceUsernames'>) {
  const overrides = form.aiOverrides;
  const setMode = (key: 'imageAltText' | 'translation' | 'summarization' | 'cleanup' | 'hashtags', mode: AIOverrideMode) =>
    onFormChange((current) => {
      if (key === 'imageAltText') {
        return { ...current, aiOverrides: { ...current.aiOverrides, imageAltText: mode } };
      }
      return {
        ...current,
        aiOverrides: {
          ...current.aiOverrides,
          textCapabilities: { ...current.aiOverrides.textCapabilities, [key]: mode },
        },
      };
    });

  const rows: Array<{ key: 'imageAltText' | 'translation' | 'summarization' | 'cleanup' | 'hashtags'; label: string; value: AIOverrideMode }> = [
    { key: 'imageAltText', label: 'Image alt text', value: overrides.imageAltText },
    { key: 'cleanup', label: 'Cleanup', value: overrides.textCapabilities.cleanup },
    { key: 'translation', label: 'Translation', value: overrides.textCapabilities.translation },
    { key: 'summarization', label: 'Summarization', value: overrides.textCapabilities.summarization },
    { key: 'hashtags', label: 'Hashtags', value: overrides.textCapabilities.hashtags },
  ];

  return (
    <fieldset className="space-y-3 rounded-md border p-4" data-testid={`${idPrefix}-ai-overrides`}>
      <legend className="px-1 text-sm font-semibold">Destination AI overrides</legend>
      <p className="text-xs text-muted-foreground">
        Inherit uses the global AI settings. Enable/disable overrides that setting for this destination only.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.key} className="space-y-1">
            <Label htmlFor={`${idPrefix}-ai-${row.key}`}>{row.label}</Label>
            <select
              id={`${idPrefix}-ai-${row.key}`}
              className={selectClassName}
              value={row.value}
              onChange={(event) => setMode(row.key, event.target.value as AIOverrideMode)}
            >
              <option value="inherit">Inherit</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export function ProfileSyncActions({
  form,
  busy,
  onPreviewProfile,
  onApplyProfile,
  onQueuePinSync,
}: ProfileSyncActionsProps) {
  if (!form.profileManagement.allowProfileMutation) return null;
  const canProfile = form.profileManagement.profileSync.mode !== 'off';
  const canPin = form.profileManagement.pinSync.mode !== 'off';
  if (!canProfile && !canPin) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="profile-sync-actions">
      {canProfile ? (
        <>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onPreviewProfile}>
            Preview profile sync
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onApplyProfile}>
            Apply profile sync
          </Button>
        </>
      ) : null}
      {canPin ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onQueuePinSync}>
          Queue pin sync
        </Button>
      ) : null}
    </div>
  );
}
