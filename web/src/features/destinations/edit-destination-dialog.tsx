import { X } from 'lucide-react';
import { useEffect, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { validateAttributionTemplate } from '../../lib/dashboard-utils';
import { ConnectionList } from './connection-list';
import { ContentPolicyPanel } from './content-policy-panel';
import {
  AttributionPolicyFields,
  DestinationAiOverridesFields,
  PostingPolicyPreview,
  ProfileMutationField,
  ProfileSyncActions,
} from './policy-controls';
import { RouteDeliveryPanel } from './route-delivery-panel';
import { SourceFiltersPanel } from './source-filters-panel';
import type { AccountMapping, MappingFormState, SourceFilterPolicy, SourceParseSummary } from './types';

interface EditDestinationDialogProps {
  mapping: AccountMapping | null;
  form: MappingFormState;
  sources: string[];
  sourceInput: string;
  parseSummary: SourceParseSummary;
  busy: boolean;
  onClose(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onFormChange(update: (current: MappingFormState) => MappingFormState): void;
  onSourceInputChange(value: string): void;
  onAddSources(): void;
  onRemoveSource(username: string): void;
  onTestCredentials(): void;
  onSaveCredentials(): void;
  onSaveSourceFilters(username: string, filters: SourceFilterPolicy): Promise<void>;
  onPreviewSourceFilter(
    username: string,
    filters: SourceFilterPolicy,
    metadata: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason: string }>;
  onPreviewPosting(input: {
    text: string;
    twitterUsername?: string;
    postingPolicy: MappingFormState['postingPolicy'];
  }): Promise<{ text: string; attributionApplied: boolean; originalLinkApplied: boolean }>;
  onPreviewProfileSync(): void;
  onApplyProfileSync(): void;
  onQueuePinSync(): void;
  onSaveContentPolicy: Parameters<typeof ContentPolicyPanel>[0]['onSave'];
  onPreviewContentPolicy: Parameters<typeof ContentPolicyPanel>[0]['onPreview'];
  onSaveRouteDelivery: Parameters<typeof RouteDeliveryPanel>[0]['onSave'];
  initialSection?: string;
}

const SCROLL_SECTION_IDS = {
  sources: 'destination-section-sources',
  moderation: 'destination-section-moderation',
  delivery: 'destination-section-delivery',
} as const;

function scrollToDestinationSection(section: string): void {
  const id = SCROLL_SECTION_IDS[section as keyof typeof SCROLL_SECTION_IDS] ?? `destination-section-${section}`;
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function EditDestinationDialog(props: EditDestinationDialogProps) {
  const templateError = validateAttributionTemplate(props.form.postingPolicy.attribution.template);
  const mappingId = props.mapping?.id;
  const initialSection = props.initialSection;
  useEffect(() => {
    if (!mappingId || !initialSection) return;
    const frame = window.requestAnimationFrame(() => scrollToDestinationSection(initialSection));
    return () => window.cancelAnimationFrame(frame);
  }, [mappingId, initialSection]);
  return (
    <Dialog
      open={props.mapping !== null}
      onClose={props.onClose}
      titleId="edit-destination-title"
      descriptionId="edit-destination-description"
      variant="sheet"
      panelClassName="h-full w-full overflow-y-auto bg-background shadow-2xl sm:max-w-xl"
    >
      <form className="flex min-h-full flex-col" onSubmit={props.onSubmit}>
        <header className="flex items-start justify-between gap-3 border-b p-5">
          <div>
            <h2 id="edit-destination-title" className="text-xl font-semibold">Edit Bluesky Destination</h2>
            <p id="edit-destination-description" className="text-sm text-muted-foreground">
              Update folder, sources, attribution, and profile automation for @{props.mapping?.bskyIdentifier}.
            </p>
          </div>
          <Button type="button" size="icon" variant="ghost" aria-label="Close edit destination" onClick={props.onClose}><X className="h-4 w-4" /></Button>
        </header>
        <div className="flex-1 space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><Label htmlFor="edit-owner">Owner</Label><Input id="edit-owner" data-autofocus value={props.form.owner} onChange={(event) => props.onFormChange((current) => ({ ...current, owner: event.target.value }))} /></div>
            <div><Label htmlFor="edit-group">Folder name</Label><Input id="edit-group" value={props.form.groupName} onChange={(event) => props.onFormChange((current) => ({ ...current, groupName: event.target.value }))} /></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-source-input">Add X sources</Label>
            <div className="flex gap-2"><Input id="edit-source-input" value={props.sourceInput} onChange={(event) => props.onSourceInputChange(event.target.value)} /><Button type="button" variant="outline" onClick={props.onAddSources}>Add</Button></div>
            <div className="flex flex-wrap gap-2">
              {props.sources.map((username) => (
                <span key={username} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm">@{username}<button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" aria-label={`Remove @${username}`} onClick={() => props.onRemoveSource(username)}><X aria-hidden="true" className="h-3 w-3" /></button></span>
              ))}
            </div>
            {props.parseSummary.invalid.map((entry, index) => <p key={`${entry.input}-${index}`} role="alert" className="text-xs text-red-600">{entry.input}: {entry.reason}</p>)}
          </div>
          {props.mapping ? (
            <>
              <div id="destination-section-sources">
                <SourceFiltersPanel
                  mapping={props.mapping}
                  busy={props.busy}
                  onSaveFilters={props.onSaveSourceFilters}
                  onPreviewFilter={props.onPreviewSourceFilter}
                />
              </div>
              <ConnectionList mapping={props.mapping} onOpenSection={(section) => scrollToDestinationSection(section)} />
              <div id="destination-section-moderation">
                <ContentPolicyPanel
                  key={props.mapping.id}
                  mapping={props.mapping}
                  busy={props.busy}
                  onSave={props.onSaveContentPolicy}
                  onPreview={props.onPreviewContentPolicy}
                />
              </div>
              <div id="destination-section-delivery">
                <RouteDeliveryPanel
                  key={`${props.mapping.id}-delivery`}
                  mapping={props.mapping}
                  busy={props.busy}
                  onSave={props.onSaveRouteDelivery}
                />
              </div>
            </>
          ) : null}
          <AttributionPolicyFields
            idPrefix="edit-destination"
            form={props.form}
            sourceCount={props.sources.length}
            onFormChange={props.onFormChange}
          />
          <PostingPolicyPreview
            idPrefix="edit-destination"
            form={props.form}
            sourceUsernames={props.sources}
            busy={props.busy}
            onPreview={props.onPreviewPosting}
          />
          <DestinationAiOverridesFields
            idPrefix="edit-destination"
            form={props.form}
            onFormChange={props.onFormChange}
          />
          <ProfileMutationField
            idPrefix="edit-destination"
            form={props.form}
            sourceUsernames={props.sources}
            onFormChange={props.onFormChange}
          />
          <ProfileSyncActions
            form={props.form}
            busy={props.busy}
            onPreviewProfile={props.onPreviewProfileSync}
            onApplyProfile={props.onApplyProfileSync}
            onQueuePinSync={props.onQueuePinSync}
          />
          <div className="space-y-3 rounded-md border p-4">
            <div>
              <p className="font-semibold">Bluesky credentials</p>
              <p className="text-xs text-muted-foreground">
                Testing is read-only. Saving source and policy changes never sends or changes the app password.
              </p>
            </div>
            <Label htmlFor="edit-bsky-password">New app password</Label>
            <Input
              id="edit-bsky-password"
              type="password"
              value={props.form.bskyPassword}
              onChange={(event) =>
                props.onFormChange((current) => ({ ...current, bskyPassword: event.target.value }))
              }
              placeholder="Leave blank to keep the saved credential"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={!props.form.bskyPassword || props.busy} onClick={props.onTestCredentials}>
                Test credentials
              </Button>
              <Button type="button" variant="outline" disabled={!props.form.bskyPassword || props.busy} onClick={props.onSaveCredentials}>
                Save credentials
              </Button>
            </div>
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t p-5"><Button type="button" variant="outline" onClick={props.onClose}>Cancel</Button><Button type="submit" disabled={props.busy || templateError !== null}>{props.busy ? 'Saving…' : 'Save Destination'}</Button></footer>
      </form>
    </Dialog>
  );
}
