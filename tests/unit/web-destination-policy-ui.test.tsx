import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditDestinationDialog } from '../../web/src/features/destinations/edit-destination-dialog';
import { AttributionPolicyFields, ProfileMutationField } from '../../web/src/features/destinations/policy-controls';
import type { AccountMapping, MappingFormState } from '../../web/src/features/destinations/types';
import { SchedulerSection } from '../../web/src/features/settings/settings-sections';
import type { SchedulerSettings } from '../../web/src/features/status/types';
import { defaultMappingForm } from '../../web/src/lib/dashboard-utils';

const form = (patch: (current: MappingFormState) => MappingFormState = (current) => current): MappingFormState =>
  patch(defaultMappingForm());

const mapping = (): AccountMapping =>
  ({
    revision: 3,
    updatedAt: '2026-07-24T20:00:00.000Z',
    id: 'destination-1',
    twitterUsernames: ['alpha', 'beta'],
    pausedTwitterUsernames: [],
    bskyIdentifier: 'aggregate.bsky.social',
    bskyServiceUrl: 'https://bsky.social',
    enabled: true,
    credentialConfigured: true,
  }) as unknown as AccountMapping;

const dialogProps = {
  sources: ['alpha', 'beta'] as string[],
  sourceInput: '',
  parseSummary: { duplicates: [], invalid: [] },
  busy: false,
  globalInitialImportDefault: 'new-only' as const,
  addSourcesInitialImportMode: 'inherit' as const,
  onClose: () => undefined,
  onSubmit: () => undefined,
  onFormChange: () => undefined,
  onSourceInputChange: () => undefined,
  onAddSourcesInitialImportModeChange: () => undefined,
  onAddSources: async () => undefined,
  onRemoveSource: () => undefined,
  onManageAccount: () => undefined,
  onSaveSourceFilters: async () => undefined,
  onSaveSourceSchedule: async () => undefined,
  schedulerIntervalMinutes: 5,
  onPreviewSourceFilter: async () => ({ allowed: true, reason: 'allowed' }),
  onPreviewPosting: async () => ({ text: 'preview', attributionApplied: false, originalLinkApplied: false }),
  onPreviewProfileSync: () => undefined,
  onApplyProfileSync: () => undefined,
  onQueuePinSync: () => undefined,
};

const scheduler = (intervalMinutes: number): SchedulerSettings => ({
  revision: 3,
  updatedAt: '2026-07-24T20:00:00.000Z',
  enabled: true,
  intervalMinutes,
  runOnStartup: false,
  lastCheckTime: null,
  nextCheckTime: null,
  enabledSourceCount: 24,
  estimatedChecksPerHour: 0,
  diagnostics: {
    scraperMinGapMs: 800,
    scraperJitterMs: 400,
    scraperMaxRequestsPerWindow: 150,
    scraperWindowMs: 900_000,
    scraperCooldownBaseMs: 30_000,
    scraperCooldownMaxMs: 900_000,
    schedulerMaxSourcesPerSweep: 25,
    schedulerJitterPercent: 10,
    fetchConcurrency: 4,
  },
});

describe('attribution policy control', () => {
  test('explains that a single-source destination will not prefix posts', () => {
    const markup = renderToStaticMarkup(
      <AttributionPolicyFields
        idPrefix="add-destination"
        form={form()}
        sourceCount={1}
        onFormChange={() => undefined}
      />,
    );

    expect(markup).toContain('Prepend the X username');
    expect(markup).toContain('Mirrored posts are never prefixed');
  });

  test('reports attribution as active for an aggregate destination', () => {
    const markup = renderToStaticMarkup(
      <AttributionPolicyFields
        idPrefix="add-destination"
        form={form((current) => ({
          ...current,
          postingPolicy: {
            ...current.postingPolicy,
            attribution: { ...current.postingPolicy.attribution, mode: 'multiple-sources' },
          },
        }))}
        sourceCount={3}
        onFormChange={() => undefined}
      />,
    );

    expect(markup).toContain('this destination has 3 X sources');
  });

  test('surfaces an unsupported template variable as an alert', () => {
    const markup = renderToStaticMarkup(
      <AttributionPolicyFields
        idPrefix="add-destination"
        form={form((current) => ({
          ...current,
          postingPolicy: {
            ...current.postingPolicy,
            attribution: { ...current.postingPolicy.attribution, template: 'From {handle}' },
          },
        }))}
        sourceCount={2}
        onFormChange={() => undefined}
      />,
    );

    expect(markup).toContain('unsupported variable: {handle}');
    expect(markup).toContain('role="alert"');
  });
});

describe('profile mutation control', () => {
  test('defaults to off and states that onboarding never touches the profile', () => {
    const markup = renderToStaticMarkup(
      <ProfileMutationField idPrefix="add-destination" form={form()} onFormChange={() => undefined} />,
    );

    expect(markup).toContain('Allow Bluesky profile mutation');
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain('never change the Bluesky profile');
  });

  test('still requires a sync mode once mutation is allowed', () => {
    const markup = renderToStaticMarkup(
      <ProfileMutationField
        idPrefix="add-destination"
        form={form((current) => ({
          ...current,
          profileManagement: { ...current.profileManagement, allowProfileMutation: true },
        }))}
        sourceUsernames={['alpha']}
        onFormChange={() => undefined}
      />,
    );

    expect(markup).toContain('checked=""');
    expect(markup).toContain('once a sync mode is also enabled');
    expect(markup).toContain('Profile sync mode');
    expect(markup).toContain('Pin sync mode');
  });
});

describe('edit destination dialog', () => {
  test('exposes attribution controls on the delivery section', () => {
    const markup = renderToStaticMarkup(
      <EditDestinationDialog mapping={mapping()} form={form()} {...dialogProps} initialSection="delivery" />,
    );

    expect(markup).toContain('id="edit-destination-attribution-mode"');
    expect(markup).toContain('Preview sample post');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Destination sections');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('disabled="">Save Destination</button>');
  });

  test('exposes profile mutation controls on the automation section', () => {
    const markup = renderToStaticMarkup(
      <EditDestinationDialog
        mapping={mapping()}
        form={form()}
        {...dialogProps}
        sources={['alpha']}
        initialSection="automation"
      />,
    );

    expect(markup).toContain('id="edit-destination-allow-profile-mutation"');
  });

  test('exposes source filters on the sources section', () => {
    const markup = renderToStaticMarkup(
      <EditDestinationDialog mapping={mapping()} form={form()} {...dialogProps} initialSection="sources" />,
    );

    expect(markup).toContain('Source filters');
    expect(markup).toContain('X source polling');
    expect(markup).toContain('Use global default');
    expect(markup).toContain('Current global default: Start with new posts only.');
    expect(markup).toContain('Source add/remove applies immediately');
    expect(markup).not.toContain('Source add/remove is applied when you click Save Destination');
  });

  test('blocks saving while the attribution template is invalid', () => {
    const invalid = renderToStaticMarkup(
      <EditDestinationDialog
        mapping={mapping()}
        form={form((current) => ({
          ...current,
          postingPolicy: {
            ...current.postingPolicy,
            attribution: { ...current.postingPolicy.attribution, template: 'Broken {' },
          },
        }))}
        {...dialogProps}
        sources={['alpha']}
        initialSection="delivery"
      />,
    );

    expect(invalid).toContain('disabled="">Save Destination</button>');
    expect(invalid).toContain('invalid variable expression');
  });
});

describe('scheduler interval control', () => {
  test('shows the resulting hourly check load for the configured sources', () => {
    const markup = renderToStaticMarkup(
      <SchedulerSection value={scheduler(10)} setValue={() => undefined} saving={false} onSubmit={() => undefined} />,
    );

    expect(markup).toContain('Check every (minutes)');
    expect(markup).toContain('24 enabled sources');
    expect(markup).toContain('up to about 144 timeline checks per hour');
    expect(markup).toContain('X request safety guardrails');
    expect(markup).toContain('150 per');
    expect(markup).toContain('Maximum sources per sweep');
  });

  test('rejects an out-of-range interval instead of posting it', () => {
    const markup = renderToStaticMarkup(
      <SchedulerSection value={scheduler(0)} setValue={() => undefined} saving={false} onSubmit={() => undefined} />,
    );

    expect(markup).toContain('Check interval must be between 1 and 1440 minutes.');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('disabled=""');
  });

  test('shows the safe new-only global initial import default', () => {
    const markup = renderToStaticMarkup(
      <SchedulerSection
        value={scheduler(5)}
        setValue={() => undefined}
        saving={false}
        onSubmit={() => undefined}
        sourceDefaults={{
          revision: 3,
          updatedAt: '2026-08-02T12:00:00.000Z',
          defaultInitialImportMode: 'new-only',
        }}
        setSourceDefaults={() => undefined}
        onSaveSourceDefaults={() => undefined}
      />,
    );

    expect(markup).toContain('Import existing posts when adding an X account');
    expect(markup).toContain('Off starts new sources with a baseline');
    expect(markup).toContain('Save X source default');
  });
});
