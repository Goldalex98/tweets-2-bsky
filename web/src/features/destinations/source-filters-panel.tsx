import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { filtersFingerprint, pickSelectedUsername } from './source-selection';
import type { AccountMapping, SourceFilterPolicy } from './types';

const DEFAULT_FILTERS: SourceFilterPolicy = {
  originalPosts: true,
  selfReplies: true,
  externalReplies: false,
  quotes: true,
  reposts: false,
  mediaOnly: false,
  includeKeywords: [],
  excludeKeywords: [],
  languages: [],
  sensitiveContent: 'mirror',
};

const TOGGLE_FIELDS: Array<{ key: keyof Pick<SourceFilterPolicy, 'originalPosts' | 'selfReplies' | 'externalReplies' | 'quotes' | 'reposts' | 'mediaOnly'>; label: string }> = [
  { key: 'originalPosts', label: 'Original posts' },
  { key: 'selfReplies', label: 'Self-replies / threads' },
  { key: 'externalReplies', label: 'External replies' },
  { key: 'quotes', label: 'Quote tweets' },
  { key: 'reposts', label: 'Reposts / retweets' },
  { key: 'mediaOnly', label: 'Media-only posts' },
];

function parseList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function joinList(values: string[]): string {
  return values.join(', ');
}

function draftFromFilters(filters: SourceFilterPolicy | undefined): SourceFilterPolicy {
  return {
    ...DEFAULT_FILTERS,
    ...(filters || {}),
    includeKeywords: [...(filters?.includeKeywords || [])],
    excludeKeywords: [...(filters?.excludeKeywords || [])],
    languages: [...(filters?.languages || [])],
  };
}

export interface SourceFilterPreviewResult {
  allowed: boolean;
  reason: string;
}

interface SourceFiltersPanelProps {
  mapping: AccountMapping;
  busy: boolean;
  selectedUsername?: string;
  onSelectedUsernameChange?(username: string): void;
  onSaveFilters(username: string, filters: SourceFilterPolicy): Promise<void>;
  onPreviewFilter(
    username: string,
    filters: SourceFilterPolicy,
    metadata: {
      text?: string;
      language?: string;
      sensitive?: boolean;
      hasMedia?: boolean;
      isRepost?: boolean;
      isQuote?: boolean;
      isReply?: boolean;
    },
  ): Promise<SourceFilterPreviewResult>;
}

export function SourceFiltersPanel({
  mapping,
  busy,
  selectedUsername: preferredUsername,
  onSelectedUsernameChange,
  onSaveFilters,
  onPreviewFilter,
}: SourceFiltersPanelProps) {
  const sources = mapping.sources?.length
    ? mapping.sources
    : mapping.twitterUsernames.map((username) => ({ username, state: 'enabled' as const, filters: DEFAULT_FILTERS }));
  const usernames = sources.map((source) => source.username);

  const [selected, setSelected] = useState(() => pickSelectedUsername(usernames, undefined, preferredUsername));
  const selectedUsername = pickSelectedUsername(usernames, selected, preferredUsername);
  const activeSource = sources.find((source) => source.username === selectedUsername) || sources[0];
  const [draft, setDraft] = useState<SourceFilterPolicy>(() => draftFromFilters(activeSource?.filters));
  const [includeDraft, setIncludeDraft] = useState(joinList(draft.includeKeywords));
  const [excludeDraft, setExcludeDraft] = useState(joinList(draft.excludeKeywords));
  const [languagesDraft, setLanguagesDraft] = useState(joinList(draft.languages));
  const [previewText, setPreviewText] = useState('Example post about launch day');
  const [previewResult, setPreviewResult] = useState<SourceFilterPreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadedFiltersKey, setLoadedFiltersKey] = useState(() =>
    `${selectedUsername}\0${filtersFingerprint(activeSource?.filters)}`,
  );

  const applySourceDraft = (username: string, filters: SourceFilterPolicy | undefined) => {
    const next = draftFromFilters(filters);
    setSelected(username);
    setDraft(next);
    setIncludeDraft(joinList(next.includeKeywords));
    setExcludeDraft(joinList(next.excludeKeywords));
    setLanguagesDraft(joinList(next.languages));
    setPreviewResult(null);
    setMessage(null);
    setLoadedFiltersKey(`${username}\0${filtersFingerprint(filters)}`);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: sync when membership, revision, focus, or resolved selection changes
  useEffect(() => {
    if (!selectedUsername) {
      if (selected) setSelected('');
      return;
    }
    const source = sources.find((entry) => entry.username === selectedUsername);
    const nextKey = `${selectedUsername}\0${filtersFingerprint(source?.filters)}`;
    if (selectedUsername !== selected || nextKey !== loadedFiltersKey) {
      applySourceDraft(selectedUsername, source?.filters);
    }
  }, [mapping.revision, mapping.updatedAt, usernames.join('\0'), preferredUsername, selectedUsername]);

  const syncDraftFromSource = (username: string) => {
    const source = sources.find((entry) => entry.username === username);
    applySourceDraft(username, source?.filters);
    onSelectedUsernameChange?.(username);
  };

  const resolvedDraft = useMemo(
    () => ({
      ...draft,
      includeKeywords: parseList(includeDraft),
      excludeKeywords: parseList(excludeDraft),
      languages: parseList(languagesDraft).map((entry) => entry.toLowerCase()),
    }),
    [draft, excludeDraft, includeDraft, languagesDraft],
  );

  if (!activeSource) {
    return (
      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-semibold">Source filters</legend>
        <p className="text-xs text-muted-foreground">Add at least one X source before editing filters.</p>
      </fieldset>
    );
  }

  return (
    <fieldset className="space-y-3 rounded-md border p-4" data-testid="source-filters-panel">
      <legend className="px-1 text-sm font-semibold">Source filters</legend>
      <p className="text-xs text-muted-foreground">
        Controls which posts from each X source are queued. Saving filters does not rewrite items already in the queue.
      </p>
      <div className="space-y-1">
        <Label htmlFor="source-filter-username">Source</Label>
        <select
          id="source-filter-username"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={selectedUsername}
          onChange={(event) => syncDraftFromSource(event.target.value)}
        >
          {sources.map((source) => (
            <option key={source.username} value={source.username}>
              @{source.username}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TOGGLE_FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-foreground"
              checked={draft[field.key]}
              onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.checked }))}
            />
            {field.label}
          </label>
        ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor="source-filter-sensitive">Sensitive content</Label>
        <select
          id="source-filter-sensitive"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={draft.sensitiveContent}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              sensitiveContent: event.target.value as SourceFilterPolicy['sensitiveContent'],
            }))
          }
        >
          <option value="mirror">Mirror</option>
          <option value="skip">Skip</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="source-filter-include">Include keywords (comma or newline)</Label>
        <Input id="source-filter-include" value={includeDraft} onChange={(event) => setIncludeDraft(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="source-filter-exclude">Exclude keywords</Label>
        <Input id="source-filter-exclude" value={excludeDraft} onChange={(event) => setExcludeDraft(event.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="source-filter-languages">Languages (empty = all)</Label>
        <Input
          id="source-filter-languages"
          value={languagesDraft}
          placeholder="en, ja"
          onChange={(event) => setLanguagesDraft(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => {
            void onSaveFilters(selectedUsername, resolvedDraft)
              .then(() => setMessage(`Filters saved for @${selectedUsername}.`))
              .catch(() => setMessage(null));
          }}
        >
          Save filters
        </Button>
      </div>
      <div className="space-y-2 rounded-md border border-dashed p-3">
        <Label htmlFor="source-filter-preview-text">Filter dry-run sample</Label>
        <Input
          id="source-filter-preview-text"
          value={previewText}
          onChange={(event) => setPreviewText(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={previewBusy || busy}
          onClick={() => {
            setPreviewBusy(true);
            void onPreviewFilter(selectedUsername, resolvedDraft, {
              text: previewText,
              isReply: false,
              isQuote: false,
              isRepost: false,
              hasMedia: false,
              sensitive: false,
            })
              .then((result) => setPreviewResult(result))
              .finally(() => setPreviewBusy(false));
          }}
        >
          {previewBusy ? 'Previewing…' : 'Preview filter decision'}
        </Button>
        {previewResult ? (
          <p className="text-xs" data-testid="source-filter-preview-result">
            {previewResult.allowed ? 'Would queue' : 'Would skip'}: {previewResult.reason}
          </p>
        ) : null}
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </fieldset>
  );
}
