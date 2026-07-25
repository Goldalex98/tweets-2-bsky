import {
  Bot,
  ClipboardList,
  Filter,
  Shield,
  Truck,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { NavList, type NavListItem } from '../../components/ui/nav-list';
import { normalizeTwitterUsername, validateAttributionTemplate } from '../../lib/dashboard-utils';
import { ConnectionList } from './connection-list';
import { ContentPolicyPanel } from './content-policy-panel';
import { DestinationAccountCard } from './destination-account-card';
import { HEALTH_BADGE_VARIANT, summarizeDestinationHealth } from './destination-health';
import { MigrationReviewPanel } from './migration-review-panel';
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

export const DESTINATION_SECTION_IDS = [
  'overview',
  'sources',
  'delivery',
  'moderation',
  'automation',
  'operations',
] as const;

export type DestinationSectionId = (typeof DESTINATION_SECTION_IDS)[number];

export function resolveDestinationSection(value: string | undefined): DestinationSectionId {
  return DESTINATION_SECTION_IDS.includes(value as DestinationSectionId)
    ? (value as DestinationSectionId)
    : 'overview';
}

interface EditDestinationDialogProps {
  mapping: AccountMapping | null;
  form: MappingFormState;
  sources: string[];
  sourceInput: string;
  parseSummary: SourceParseSummary;
  busy: boolean;
  canReviewMigration: boolean;
  onClose(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onFormChange(update: (current: MappingFormState) => MappingFormState): void;
  onSourceInputChange(value: string): void;
  onAddSources(): void;
  onRemoveSource(username: string): void;
  onManageAccount(): void;
  onSectionChange?(section: DestinationSectionId): void;
  onDismissMigrationReview(): void;
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

const SECTION_ITEMS: Array<NavListItem<DestinationSectionId>> = [
  { id: 'overview', label: 'Overview', icon: UserRound },
  { id: 'sources', label: 'Sources & routes', icon: Filter },
  { id: 'delivery', label: 'Delivery', icon: Truck },
  { id: 'moderation', label: 'Moderation', icon: Shield },
  { id: 'automation', label: 'Automation', icon: Bot },
  { id: 'operations', label: 'Operations', icon: ClipboardList },
];

function normalizedSourceKey(usernames: readonly string[]): string {
  return [...usernames].map(normalizeTwitterUsername).filter(Boolean).sort().join('\0');
}

function isMainFormDirty(form: MappingFormState, mapping: AccountMapping, sources: readonly string[]): boolean {
  return (
    form.owner !== (mapping.owner || '') ||
    form.groupName !== (mapping.groupName || '') ||
    form.groupEmoji !== (mapping.groupEmoji || '📁') ||
    normalizedSourceKey(sources) !== normalizedSourceKey(mapping.twitterUsernames) ||
    JSON.stringify(form.postingPolicy) !== JSON.stringify(mapping.postingPolicy) ||
    JSON.stringify(form.profileManagement) !== JSON.stringify(mapping.profileManagement) ||
    JSON.stringify(form.aiOverrides) !==
      JSON.stringify({
        imageAltText: mapping.aiOverrides?.imageAltText ?? 'inherit',
        textCapabilities: {
          translation: mapping.aiOverrides?.textCapabilities?.translation ?? 'inherit',
          summarization: mapping.aiOverrides?.textCapabilities?.summarization ?? 'inherit',
          cleanup: mapping.aiOverrides?.textCapabilities?.cleanup ?? 'inherit',
          hashtags: mapping.aiOverrides?.textCapabilities?.hashtags ?? 'inherit',
        },
      })
  );
}

export function EditDestinationDialog(props: EditDestinationDialogProps) {
  const templateError = validateAttributionTemplate(props.form.postingPolicy.attribution.template);
  const mappingId = props.mapping?.id;
  const initialSection = props.initialSection;
  const [activeSection, setActiveSection] = useState<DestinationSectionId>(() =>
    resolveDestinationSection(initialSection),
  );
  const sectionPanelRef = useRef<HTMLDivElement>(null);
  const skipInitialFocusRef = useRef(true);

  useEffect(() => {
    if (!mappingId) return;
    setActiveSection(resolveDestinationSection(initialSection));
    skipInitialFocusRef.current = true;
  }, [mappingId, initialSection]);

  useEffect(() => {
    if (!mappingId) return;
    if (skipInitialFocusRef.current) {
      skipInitialFocusRef.current = false;
      return;
    }
    // Focus the newly shown section panel after a tab change (not on first open).
    if (activeSection) {
      sectionPanelRef.current?.focus();
    }
  }, [activeSection, mappingId]);

  const confirmDiscardIfDirty = (message: string): boolean => {
    if (!props.mapping || !isMainFormDirty(props.form, props.mapping, props.sources)) return true;
    return window.confirm(message);
  };

  const applySectionChange = (next: DestinationSectionId) => {
    setActiveSection(next);
    props.onSectionChange?.(next);
  };

  const requestSectionChange = (next: DestinationSectionId) => {
    if (!props.mapping || next === activeSection) {
      applySectionChange(next);
      return;
    }
    if (
      !confirmDiscardIfDirty(
        'You have unsaved destination settings. Switch sections anyway? Use Save Destination to keep owner, folder, sources, attribution, AI, and profile changes.',
      )
    ) {
      return;
    }
    applySectionChange(next);
  };

  const requestClose = () => {
    if (
      !confirmDiscardIfDirty('You have unsaved destination settings. Close without saving?')
    ) {
      return;
    }
    props.onClose();
  };

  const requestManageAccount = () => {
    if (
      !confirmDiscardIfDirty(
        'You have unsaved destination settings. Leave for Settings without saving?',
      )
    ) {
      return;
    }
    props.onManageAccount();
  };

  const health = props.mapping ? summarizeDestinationHealth(props.mapping) : null;
  const handle = props.mapping?.bskyCanonicalHandle || props.mapping?.bskyIdentifier;

  return (
    <Dialog
      open={props.mapping !== null}
      onClose={requestClose}
      titleId="edit-destination-title"
      descriptionId="edit-destination-description"
      variant="sheet"
      panelClassName="h-full w-full overflow-hidden bg-background shadow-2xl sm:max-w-3xl"
    >
      <form className="flex h-full min-h-0 flex-col" onSubmit={props.onSubmit}>
        <header className="flex shrink-0 items-start justify-between gap-3 border-b p-5">
          <div>
            <h2 id="edit-destination-title" className="text-xl font-semibold">
              Edit Bluesky Destination
            </h2>
            <p id="edit-destination-description" className="text-sm text-muted-foreground">
              Update folder, sources, attribution, and profile automation for @{handle}.
            </p>
          </div>
          <Button type="button" size="icon" variant="ghost" aria-label="Close edit destination" onClick={requestClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[12rem_1fr]">
          <aside className="shrink-0 border-b p-3 sm:border-b-0 sm:border-r sm:overflow-y-auto">
            <div className="overflow-x-auto sm:overflow-visible">
              <NavList
                items={SECTION_ITEMS}
                activeId={activeSection}
                onSelect={requestSectionChange}
                ariaLabel="Destination sections"
                className="min-w-max flex-row sm:min-w-0 sm:flex-col"
              />
            </div>
          </aside>

          <div
            ref={sectionPanelRef}
            tabIndex={-1}
            aria-label={`${SECTION_ITEMS.find((item) => item.id === activeSection)?.label ?? 'Section'} settings`}
            className="min-h-0 overflow-y-auto p-5 outline-none"
          >
            {props.mapping && activeSection === 'overview' ? (
              <div className="space-y-5">
                <DestinationAccountCard mapping={props.mapping} onManageAccount={requestManageAccount} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="edit-owner">Owner</Label>
                    <Input
                      id="edit-owner"
                      data-autofocus
                      value={props.form.owner}
                      onChange={(event) =>
                        props.onFormChange((current) => ({ ...current, owner: event.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="edit-group">Folder name</Label>
                    <Input
                      id="edit-group"
                      value={props.form.groupName}
                      onChange={(event) =>
                        props.onFormChange((current) => ({ ...current, groupName: event.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="rounded-md border p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Status</span>
                    {health ? (
                      <Badge variant={HEALTH_BADGE_VARIANT[health.severity]} title={health.detail}>
                        {health.label}
                      </Badge>
                    ) : null}
                    <Badge variant={props.mapping.enabled ? 'success' : 'warning'}>
                      {props.mapping.enabled ? 'Enabled' : 'Paused'}
                    </Badge>
                  </div>
                  {health?.detail ? <p className="mt-2 text-xs text-muted-foreground">{health.detail}</p> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Owner and folder changes are saved with the footer Save Destination button.
                </p>
              </div>
            ) : null}

            {props.mapping && activeSection === 'sources' ? (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="edit-source-input">Add X sources</Label>
                  <div className="flex gap-2">
                    <Input
                      id="edit-source-input"
                      value={props.sourceInput}
                      onChange={(event) => props.onSourceInputChange(event.target.value)}
                    />
                    <Button type="button" variant="outline" onClick={props.onAddSources}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {props.sources.map((username) => (
                      <span key={username} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm">
                        @{username}
                        <button
                          type="button"
                          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          aria-label={`Remove @${username}`}
                          onClick={() => props.onRemoveSource(username)}
                        >
                          <X aria-hidden="true" className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  {props.parseSummary.invalid.map((entry, index) => (
                    <p key={`${entry.input}-${index}`} role="alert" className="text-xs text-red-600">
                      {entry.input}: {entry.reason}
                    </p>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Source add/remove is applied when you click Save Destination.
                  </p>
                </div>
                <SourceFiltersPanel
                  mapping={props.mapping}
                  busy={props.busy}
                  onSaveFilters={props.onSaveSourceFilters}
                  onPreviewFilter={props.onPreviewSourceFilter}
                />
                <ConnectionList
                  mapping={props.mapping}
                  onOpenSection={(section) => requestSectionChange(resolveDestinationSection(section))}
                />
              </div>
            ) : null}

            {props.mapping && activeSection === 'delivery' ? (
              <div className="space-y-5">
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
                <RouteDeliveryPanel
                  key={`${props.mapping.id}-delivery`}
                  mapping={props.mapping}
                  busy={props.busy}
                  onSave={props.onSaveRouteDelivery}
                />
                <p className="text-xs text-muted-foreground">
                  Attribution changes use Save Destination. Route delivery has its own Save delivery settings button.
                </p>
              </div>
            ) : null}

            {props.mapping && activeSection === 'moderation' ? (
              <div className="space-y-5">
                <ContentPolicyPanel
                  key={props.mapping.id}
                  mapping={props.mapping}
                  busy={props.busy}
                  onSave={props.onSaveContentPolicy}
                  onPreview={props.onPreviewContentPolicy}
                />
              </div>
            ) : null}

            {props.mapping && activeSection === 'automation' ? (
              <div className="space-y-5">
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
                <p className="text-xs text-muted-foreground">
                  AI and profile policy changes are saved with Save Destination. Sync actions run immediately.
                </p>
              </div>
            ) : null}

            {props.mapping && activeSection === 'operations' ? (
              <div className="space-y-5">
                <MigrationReviewPanel
                  mapping={props.mapping}
                  canReview={props.canReviewMigration}
                  busy={props.busy}
                  onDismiss={props.onDismissMigrationReview}
                />
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Backfill and delete remain on the destinations list row actions for this destination.
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t p-5">
          <Button type="button" variant="outline" onClick={requestClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={props.busy || templateError !== null}>
            {props.busy ? 'Saving…' : 'Save Destination'}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
