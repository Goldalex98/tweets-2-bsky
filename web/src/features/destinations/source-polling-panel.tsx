import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { formatLocalDateTime, selectClassName } from '../../lib/dashboard-utils';
import { pickSelectedUsername } from './source-selection';
import type { AccountMapping, SourceRuntimeState, SourceSchedulePolicy } from './types';

const DEFAULT_SCHEDULE: SourceSchedulePolicy = {
  mode: 'inherit',
  minIntervalMinutes: 1,
  maxIntervalMinutes: 1440,
  fixedIntervalMinutes: 5,
  timezone: 'UTC',
};

export interface SourcePollingOption {
  mapping: AccountMapping;
  username: string;
  schedule?: SourceSchedulePolicy;
  runtime?: SourceRuntimeState | null;
  destinationLabel?: string;
}

interface SourcePollingPanelProps {
  options: readonly SourcePollingOption[];
  globalIntervalMinutes: number;
  busy: boolean;
  selectedUsername?: string;
  onSelectedUsernameChange?(username: string): void;
  onSave(option: SourcePollingOption, schedule: SourceSchedulePolicy): Promise<void>;
  title?: string;
  description?: string;
}

function scheduleFromOption(option: SourcePollingOption | undefined): SourceSchedulePolicy {
  return { ...DEFAULT_SCHEDULE, ...(option?.schedule ?? {}) };
}

function scheduleFingerprint(option: SourcePollingOption | undefined): string {
  return JSON.stringify(option?.schedule ?? null);
}

function validationError(schedule: SourceSchedulePolicy): string | null {
  const values = [schedule.minIntervalMinutes, schedule.maxIntervalMinutes, schedule.fixedIntervalMinutes];
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 1440)) {
    return 'Intervals must be whole numbers between 1 and 1440 minutes.';
  }
  if (schedule.minIntervalMinutes > schedule.maxIntervalMinutes) {
    return 'Minimum interval cannot exceed maximum interval.';
  }
  if (
    schedule.fixedIntervalMinutes < schedule.minIntervalMinutes ||
    schedule.fixedIntervalMinutes > schedule.maxIntervalMinutes
  ) {
    return 'Fixed interval must be within the minimum and maximum bounds.';
  }
  return null;
}

function normalizeHiddenBounds(schedule: SourceSchedulePolicy): SourceSchedulePolicy {
  if (schedule.mode === 'adaptive') {
    return {
      ...schedule,
      fixedIntervalMinutes: Math.max(
        schedule.minIntervalMinutes,
        Math.min(schedule.maxIntervalMinutes, schedule.fixedIntervalMinutes),
      ),
    };
  }
  if (schedule.mode === 'fixed') {
    return {
      ...schedule,
      minIntervalMinutes: Math.min(schedule.minIntervalMinutes, schedule.fixedIntervalMinutes),
      maxIntervalMinutes: Math.max(schedule.maxIntervalMinutes, schedule.fixedIntervalMinutes),
    };
  }
  return schedule;
}

function RuntimeValue({ label, value }: { label: string; value?: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value ? formatLocalDateTime(value) : 'Never'}</dd>
    </div>
  );
}

export function SourcePollingPanel({
  options,
  globalIntervalMinutes,
  busy,
  selectedUsername: preferredUsername,
  onSelectedUsernameChange,
  onSave,
  title = 'X source polling',
  description = 'Choose how frequently each X source becomes eligible for a timeline fetch.',
}: SourcePollingPanelProps) {
  const usernames = options.map((option) => option.username);
  const [selected, setSelected] = useState(() => pickSelectedUsername(usernames, undefined, preferredUsername));
  const selectedUsername = pickSelectedUsername(usernames, selected, preferredUsername);
  const activeOption = options.find((option) => option.username === selectedUsername) ?? options[0];
  const [draft, setDraft] = useState<SourceSchedulePolicy>(() => scheduleFromOption(activeOption));
  const [loadedKey, setLoadedKey] = useState(
    () => `${activeOption?.mapping.revision ?? 0}\0${selectedUsername}\0${scheduleFingerprint(activeOption)}`,
  );
  const [message, setMessage] = useState<string | null>(null);

  const loadOption = (option: SourcePollingOption) => {
    setSelected(option.username);
    setDraft(scheduleFromOption(option));
    setMessage(null);
    setLoadedKey(`${option.mapping.revision}\0${option.username}\0${scheduleFingerprint(option)}`);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: synchronize only when server policy, membership, or focus changes
  useEffect(() => {
    if (!activeOption) return;
    const nextKey = `${activeOption.mapping.revision}\0${activeOption.username}\0${scheduleFingerprint(activeOption)}`;
    if (activeOption.username !== selected || nextKey !== loadedKey) loadOption(activeOption);
  }, [preferredUsername, selectedUsername, options.map((option) => `${option.username}:${option.mapping.revision}:${scheduleFingerprint(option)}`).join('\0')]);

  if (!activeOption) {
    return (
      <fieldset className="space-y-2 rounded-md border p-4">
        <legend className="px-1 text-sm font-semibold">{title}</legend>
        <p className="text-xs text-muted-foreground">Add an X source before configuring polling.</p>
      </fieldset>
    );
  }

  const resolvedDraft = normalizeHiddenBounds(draft);
  const error = validationError(resolvedDraft);
  const requestedFastest = draft.mode === 'fixed' ? draft.fixedIntervalMinutes : draft.minIntervalMinutes;
  const wakeConstraint = draft.mode !== 'inherit' && requestedFastest < globalIntervalMinutes;
  const runtime = activeOption.runtime;

  return (
    <fieldset className="space-y-4 rounded-md border p-4" data-testid="source-polling-panel">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="space-y-1">
        <Label htmlFor="source-polling-username">Source</Label>
        <select
          id="source-polling-username"
          className={selectClassName}
          value={selectedUsername}
          onChange={(event) => {
            const option = options.find((candidate) => candidate.username === event.target.value);
            if (!option) return;
            loadOption(option);
            onSelectedUsernameChange?.(option.username);
          }}
        >
          {options.map((option) => (
            <option key={`${option.mapping.id}-${option.username}`} value={option.username}>
              @{option.username}{option.destinationLabel ? ` — ${option.destinationLabel}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="source-polling-mode">Polling policy</Label>
        <select
          id="source-polling-mode"
          className={selectClassName}
          value={draft.mode}
          onChange={(event) =>
            setDraft((current) => ({ ...current, mode: event.target.value as SourceSchedulePolicy['mode'] }))
          }
        >
          <option value="inherit">Inherit global interval</option>
          <option value="adaptive">Adaptive</option>
          <option value="fixed">Fixed interval</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {draft.mode === 'inherit'
            ? `Uses the global ${globalIntervalMinutes}-minute scheduler interval.`
            : draft.mode === 'adaptive'
              ? 'Checks active sources quickly, then exponentially backs off quiet or failing sources.'
              : 'Checks this source at a consistent interval.'}
        </p>
      </div>

      {draft.mode === 'adaptive' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="source-polling-min">Minimum interval (minutes)</Label>
            <Input
              id="source-polling-min"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={draft.minIntervalMinutes}
              onChange={(event) =>
                setDraft((current) => ({ ...current, minIntervalMinutes: Number(event.target.value) }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-polling-max">Maximum interval (minutes)</Label>
            <Input
              id="source-polling-max"
              type="number"
              min={1}
              max={1440}
              step={1}
              value={draft.maxIntervalMinutes}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxIntervalMinutes: Number(event.target.value) }))
              }
            />
          </div>
        </div>
      ) : null}

      {draft.mode === 'fixed' ? (
        <div className="space-y-1">
          <Label htmlFor="source-polling-fixed">Fixed interval (minutes)</Label>
          <Input
            id="source-polling-fixed"
            type="number"
            min={1}
            max={1440}
            step={1}
            value={draft.fixedIntervalMinutes}
            onChange={(event) =>
              setDraft((current) => ({ ...current, fixedIntervalMinutes: Number(event.target.value) }))
            }
          />
        </div>
      ) : null}

      {wakeConstraint ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          The global scheduler wakes every {globalIntervalMinutes} minutes, so this source cannot actually be checked
          every {requestedFastest} minute{requestedFastest === 1 ? '' : 's'} until the global interval is lowered.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}

      <Button
        type="button"
        size="sm"
        disabled={busy || error !== null}
        onClick={() => {
          setMessage(null);
          void onSave(activeOption, resolvedDraft)
            .then(() => setMessage(`Polling policy saved for @${activeOption.username}.`))
            .catch(() => setMessage(null));
        }}
      >
        Save polling policy
      </Button>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}

      <div className="rounded-md border border-dashed p-3">
        <p className="mb-2 text-sm font-medium">Runtime status</p>
        <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <RuntimeValue label="Last check" value={runtime?.lastCheckAt} />
          <RuntimeValue label="Last successful fetch" value={runtime?.lastFetchSuccessAt} />
          <RuntimeValue label="Last post observed" value={runtime?.lastTweetSeenAt} />
          <RuntimeValue label="Next eligible check" value={runtime?.nextEligibleCheckAt} />
          <div>
            <dt className="text-muted-foreground">Consecutive failures</dt>
            <dd>{runtime?.consecutiveFailures ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Latest error</dt>
            <dd className="break-words">{runtime?.lastErrorMessage || runtime?.lastErrorCategory || 'None'}</dd>
          </div>
        </dl>
      </div>
    </fieldset>
  );
}

export function uniquePollingOptions(mappings: readonly AccountMapping[]): SourcePollingOption[] {
  const options = new Map<string, SourcePollingOption>();
  for (const mapping of mappings) {
    for (const source of mapping.sources ?? []) {
      const key = source.username.toLowerCase();
      if (options.has(key)) continue;
      options.set(key, {
        mapping,
        username: source.username,
        schedule: source.schedule,
        runtime: source.runtime,
        destinationLabel: `@${mapping.bskyCanonicalHandle || mapping.bskyIdentifier}`,
      });
    }
  }
  return [...options.values()].sort((left, right) => left.username.localeCompare(right.username));
}
