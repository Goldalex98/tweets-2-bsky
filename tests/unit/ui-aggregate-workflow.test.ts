import { expect, test } from 'bun:test';
import fs from 'node:fs';

const destinationHookSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/use-destinations.ts', import.meta.url),
  'utf8',
);
const destinationDialogSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/edit-destination-dialog.tsx', import.meta.url),
  'utf8',
);
const destinationAccountCardSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/destination-account-card.tsx', import.meta.url),
  'utf8',
);
const appShellSource = fs.readFileSync(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const destinationWizardSource = fs.readFileSync(
  new URL('../../web/src/features/destinations/add-destination-wizard.tsx', import.meta.url),
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
  expect(destinationWizardSource).toContain(
    "allowProfileMutation ? 'Mutations allowed (sync modes still off)' : 'Mutations disabled'",
  );
  expect(settingsSource).toContain('value.intervalMinutes');
});

test('destination onboarding can reuse a managed Bluesky account', () => {
  expect(destinationWizardSource).toContain('Use an existing Bluesky account');
  expect(destinationWizardSource).toContain('Connect a new Bluesky account');
  expect(destinationWizardSource).toContain('BlueskyAccountSelect');
  expect(destinationWizardSource).toContain('Settings → Bluesky accounts');
});

test('the destination editor can repoint a destination at another managed account', () => {
  expect(destinationAccountCardSource).toContain('BlueskyAccountSelect');
  expect(destinationAccountCardSource).toContain('Switch account');
  expect(destinationAccountCardSource).toContain('Link account');
  // Repointing uses the dedicated link route, never the credential route.
  expect(destinationHookSource).toContain('/bluesky-account');
});

test('source edits stay isolated and credentials leave the destination editor', () => {
  expect(destinationHookSource).toContain('/sources/${encodeURIComponent(username)}');
  expect(destinationHookSource).not.toContain('/credentials');
  expect(destinationDialogSource).not.toContain('type="password"');
  expect(destinationDialogSource).not.toContain('bskyPassword');
  expect(destinationDialogSource).not.toContain('app password');
  expect(destinationAccountCardSource).toContain('App passwords are never shown here');
  expect(destinationAccountCardSource).toContain('Settings → Bluesky accounts');
  expect(destinationDialogSource).toContain('Destination sections');
  expect(destinationDialogSource).toContain("'overview'");
  expect(destinationDialogSource).toContain("'operations'");
});
