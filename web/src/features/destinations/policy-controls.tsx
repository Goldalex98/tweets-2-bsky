import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  ATTRIBUTION_MODE_OPTIONS,
  describeAttribution,
  selectClassName,
  validateAttributionTemplate,
} from '../../lib/dashboard-utils';
import type { AttributionMode, MappingFormState } from './types';

interface PolicyFieldsProps {
  idPrefix: string;
  form: MappingFormState;
  sourceCount: number;
  onFormChange(update: (current: MappingFormState) => MappingFormState): void;
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

export function ProfileMutationField({
  idPrefix,
  form,
  onFormChange,
}: Omit<PolicyFieldsProps, 'sourceCount'>) {
  const checkboxId = `${idPrefix}-allow-profile-mutation`;
  const descriptionId = `${idPrefix}-allow-profile-mutation-description`;
  const allowed = form.profileManagement.allowProfileMutation;
  return (
    <div className="rounded-md border p-4">
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
            onFormChange((current) => ({
              ...current,
              profileManagement: { ...current.profileManagement, allowProfileMutation: event.target.checked },
            }))
          }
        />
      </div>
    </div>
  );
}
