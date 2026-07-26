import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { selectClassName } from '../../lib/dashboard-utils';
import { pickSelectedUsername } from './source-selection';
import type { AccountMapping, RouteDeliveryPolicy } from './types';

interface RouteDeliveryPanelProps {
  mapping: AccountMapping;
  busy: boolean;
  selectedUsername?: string;
  onSelectedUsernameChange?(username: string): void;
  onSave(routeId: string, delivery: RouteDeliveryPolicy): Promise<void>;
}

export function RouteDeliveryPanel({
  mapping,
  busy,
  selectedUsername: preferredUsername,
  onSelectedUsernameChange,
  onSave,
}: RouteDeliveryPanelProps) {
  const sources = (mapping.sources ?? []).filter((source) => source.routeId);
  const usernames = sources.map((source) => source.username);
  const initialUsername = pickSelectedUsername(usernames, undefined, preferredUsername);
  const initialSource = sources.find((source) => source.username === initialUsername) ?? sources[0];
  const [selectedRouteId, setSelectedRouteId] = useState(initialSource?.routeId || '');
  const selected = sources.find((source) => source.routeId === selectedRouteId) ?? sources[0];
  const [mode, setMode] = useState<'immediate' | 'digest'>(selected?.delivery?.mode || 'immediate');
  const [timezone, setTimezone] = useState(selected?.delivery?.digest?.timezone || 'UTC');
  const [hour, setHour] = useState(String(selected?.delivery?.digest?.hour ?? 9));
  const [minute, setMinute] = useState(String(selected?.delivery?.digest?.minute ?? 0));
  const [cadence, setCadence] = useState<'hourly' | 'daily' | 'weekly'>(
    selected?.delivery?.digest?.cadence || 'daily',
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: sync only when membership, revision, or focus changes
  useEffect(() => {
    const nextUsername = pickSelectedUsername(
      usernames,
      selected?.username,
      preferredUsername,
    );
    const nextSource = sources.find((source) => source.username === nextUsername) ?? sources[0];
    if (!nextSource?.routeId) {
      setSelectedRouteId('');
      return;
    }
    if (nextSource.routeId !== selectedRouteId) {
      setSelectedRouteId(nextSource.routeId);
    }
  }, [mapping.revision, mapping.updatedAt, usernames.join('\0'), preferredUsername]);

  useEffect(() => {
    if (!selected) return;
    setMode(selected.delivery?.mode || 'immediate');
    setTimezone(selected.delivery?.digest?.timezone || 'UTC');
    setHour(String(selected.delivery?.digest?.hour ?? 9));
    setMinute(String(selected.delivery?.digest?.minute ?? 0));
    setCadence(selected.delivery?.digest?.cadence || 'daily');
  }, [selected]);

  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground">Add an X source to configure route delivery.</p>;
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <h4 className="font-medium">Route delivery mode</h4>
      <p className="text-xs text-muted-foreground">
        Immediate posts each matched source item. Digest batches them on a schedule. Queued work keeps its captured
        policy until you explicitly re-evaluate it.
      </p>
      <div>
        <Label htmlFor="route-delivery-source">Source route</Label>
        <select
          id="route-delivery-source"
          className={selectClassName}
          value={selected?.routeId || ''}
          onChange={(event) => {
            const routeId = event.target.value;
            setSelectedRouteId(routeId);
            const source = sources.find((entry) => entry.routeId === routeId);
            if (source) onSelectedUsernameChange?.(source.username);
          }}
        >
          {sources.map((source) => (
            <option key={source.routeId} value={source.routeId}>
              @{source.username}
              {source.delivery?.mode === 'digest' ? ' (digest)' : ' (immediate)'}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="route-delivery-mode">Delivery mode</Label>
        <select
          id="route-delivery-mode"
          className={selectClassName}
          value={mode}
          onChange={(event) => setMode(event.target.value as 'immediate' | 'digest')}
        >
          <option value="immediate">Immediate</option>
          <option value="digest">Digest</option>
        </select>
      </div>
      {mode === 'digest' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="route-delivery-cadence">Cadence</Label>
            <select
              id="route-delivery-cadence"
              className={selectClassName}
              value={cadence}
              onChange={(event) => setCadence(event.target.value as 'hourly' | 'daily' | 'weekly')}
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <Label htmlFor="route-delivery-timezone">Timezone</Label>
            <Input id="route-delivery-timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="route-delivery-hour">Hour (0–23)</Label>
            <Input id="route-delivery-hour" type="number" min={0} max={23} value={hour} onChange={(event) => setHour(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="route-delivery-minute">Minute (0–59)</Label>
            <Input
              id="route-delivery-minute"
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(event) => setMinute(event.target.value)}
            />
          </div>
        </div>
      ) : null}
      <Button
        type="button"
        disabled={busy || !selected?.routeId}
        onClick={() => {
          if (!selected?.routeId) return;
          const parsedHour = Math.max(0, Math.min(23, Number(hour) || 0));
          const parsedMinute = Math.max(0, Math.min(59, Number(minute) || 0));
          void onSave(selected.routeId, {
            mode,
            digest: {
              enabled: mode === 'digest',
              cadence,
              timezone: timezone.trim() || 'UTC',
              hour: parsedHour,
              minute: parsedMinute,
              grouping: selected.delivery?.digest?.grouping || 'none',
              template: selected.delivery?.digest?.template || '',
              maxEntries: selected.delivery?.digest?.maxEntries || 20,
              maxGraphemes: selected.delivery?.digest?.maxGraphemes || 300,
              includeSourceAttribution: selected.delivery?.digest?.includeSourceAttribution ?? true,
            },
          });
        }}
      >
        Save delivery settings
      </Button>
    </div>
  );
}
