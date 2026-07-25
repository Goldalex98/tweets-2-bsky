import fs from 'node:fs';
import { expect, test } from 'bun:test';

const appShellSource = fs.readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const destinationWizardSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/add-destination-wizard.tsx', import.meta.url),
  'utf8',
);
const destinationDialogSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/edit-destination-dialog.tsx', import.meta.url),
  'utf8',
);
const destinationHookSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/use-destinations.ts', import.meta.url),
  'utf8',
);
const settingsSource = fs.readFileSync(
  new URL('../../web/src/features/settings/settings-sections.tsx', import.meta.url),
  'utf8',
);

test('application entry point stays a dashboard shell', () => {
  expect(appShellSource).toContain("import DashboardApp from './DashboardApp'");
  expect(appShellSource.split('\n').length).toBeLessThan(10);
});

test('destination onboarding exposes aggregate review and safe backfill defaults', () => {
  expect(destinationWizardSource).toContain('Create Bluesky Destination');
  expect(destinationWizardSource).toContain('X Sources ({props.sources.length})');
  expect(destinationWizardSource).toContain('Backfill:</strong> None (request separately after creation)');
  expect(destinationWizardSource).toContain('Profile &amp; pin policy:</strong>');
  // The review step must show mutations off unless the operator opted in.
  expect(destinationWizardSource).toContain(
    "allowProfileMutation ? 'Mutations allowed (sync modes still off)' : 'Mutations disabled'",
  );
  expect(settingsSource).toContain('value.intervalMinutes');
});

test('source and credential edits use isolated APIs', () => {
  expect(destinationHookSource).toContain('/sources/${encodeURIComponent(username)}');
  expect(destinationHookSource).toContain('/credentials/test');
  expect(destinationHookSource).toContain('/credentials`');
  expect(destinationDialogSource).toContain('Saving source and');
  expect(destinationDialogSource).toContain('policy changes never sends or changes the app password');
});
