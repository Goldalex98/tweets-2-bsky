import { X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  ADD_ACCOUNT_STEP_COUNT,
  ADD_ACCOUNT_STEPS,
  describeAttribution,
  validateAttributionTemplate,
} from '../../lib/dashboard-utils';
import { AttributionPolicyFields, ProfileMutationField } from './policy-controls';
import type { MappingFormState, SourceParseSummary } from './types';

interface AddDestinationWizardProps {
  open: boolean;
  step: number;
  sourceInput: string;
  sources: string[];
  parseSummary: SourceParseSummary;
  form: MappingFormState;
  busy: boolean;
  validating: boolean;
  onClose(): void;
  onSourceInputChange(value: string): void;
  onAddSources(): void;
  onRemoveSource(username: string): void;
  onFormChange(update: (current: MappingFormState) => MappingFormState): void;
  onNext(): void;
  onBack(): void;
  onCreate(): void;
}

export function AddDestinationWizard(props: AddDestinationWizardProps) {
  const templateError = validateAttributionTemplate(props.form.postingPolicy.attribution.template);
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      titleId="add-destination-title"
      descriptionId="add-destination-description"
      variant="sheet"
      panelClassName="h-[min(92vh,760px)] w-full overflow-y-auto bg-background shadow-2xl sm:h-full sm:max-w-xl"
    >
      <div className="flex min-h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b p-5">
          <div>
            <h2 id="add-destination-title" className="text-xl font-semibold">Create Bluesky Destination</h2>
            <p id="add-destination-description" className="text-sm text-muted-foreground">
              Add one or more X sources without implicit profile mutations.
            </p>
          </div>
          <Button aria-label="Close add destination flow" size="icon" variant="ghost" onClick={props.onClose}><X aria-hidden="true" className="h-4 w-4" /></Button>
        </header>
        <ol className="grid grid-cols-4 border-b">
          {ADD_ACCOUNT_STEPS.map((label, index) => (
            <li
              key={label}
              aria-current={props.step === index + 1 ? 'step' : undefined}
              className={`px-2 py-3 text-center text-xs ${props.step === index + 1 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
            >
              <span className="block">{index + 1}</span>{label}
            </li>
          ))}
        </ol>
        <div className="flex-1 space-y-5 p-5">
          {props.step === 1 ? <SourcesStep {...props} /> : null}
          {props.step === 2 ? <CreateStep {...props} /> : null}
          {props.step === 3 ? <CredentialsStep {...props} /> : null}
          {props.step === 4 ? <ReviewStep {...props} /> : null}
        </div>
        <footer className="flex justify-between gap-3 border-t p-5">
          <Button variant="outline" onClick={props.step === 1 ? props.onClose : props.onBack}>
            {props.step === 1 ? 'Cancel' : 'Back'}
          </Button>
          {props.step < ADD_ACCOUNT_STEP_COUNT ? (
            <Button onClick={props.onNext} disabled={props.validating}>{props.validating ? 'Validating…' : 'Next'}</Button>
          ) : (
            <Button onClick={props.onCreate} disabled={props.busy || templateError !== null}>{props.busy ? 'Creating…' : 'Create Destination'}</Button>
          )}
        </footer>
      </div>
    </Dialog>
  );
}

function SourcesStep(props: AddDestinationWizardProps) {
  return (
    <div className="space-y-4">
      <div><h3 className="font-semibold">Choose X sources</h3><p className="text-sm text-muted-foreground">Paste usernames separated by spaces, commas, or new lines.</p></div>
      <div className="space-y-2">
        <Label htmlFor="new-twitter-sources">X Sources</Label>
        <textarea
          id="new-twitter-sources"
          data-autofocus
          aria-describedby="new-twitter-sources-hint"
          className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={props.sourceInput}
          onChange={(event) => props.onSourceInputChange(event.target.value)}
        />
        <p id="new-twitter-sources-hint" className="text-xs text-muted-foreground">
          Bulk paste is supported: every valid username is added to this one Bluesky destination.
        </p>
        <Button onClick={props.onAddSources} disabled={!props.sourceInput.trim()}>Add</Button>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label={`Selected sources (${props.sources.length})`}>
        {props.sources.map((username) => (
          <li key={username} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm">
            @{username}
            <button
              type="button"
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={`Remove @${username}`}
              onClick={() => props.onRemoveSource(username)}
            >
              <X aria-hidden="true" className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      {props.parseSummary.invalid.map((entry, index) => <p key={`${entry.input}-${index}`} role="alert" className="text-xs text-red-600">{entry.input}: {entry.reason}</p>)}
      {props.parseSummary.duplicates.length > 0 ? <p className="text-xs text-muted-foreground">Duplicate usernames were ignored.</p> : null}
    </div>
  );
}

function CreateStep(props: AddDestinationWizardProps) {
  return (
    <div className="space-y-4">
      <div><h3 className="font-semibold">Destination details</h3><p className="text-sm text-muted-foreground">Optional ownership and folder metadata.</p></div>
      <Label htmlFor="new-owner">Owner</Label>
      <Input id="new-owner" data-autofocus value={props.form.owner} onChange={(event) => props.onFormChange((current) => ({ ...current, owner: event.target.value }))} />
      <Label htmlFor="new-group-name">Folder name</Label>
      <Input id="new-group-name" value={props.form.groupName} onChange={(event) => props.onFormChange((current) => ({ ...current, groupName: event.target.value }))} />
    </div>
  );
}

function CredentialsStep(props: AddDestinationWizardProps) {
  return (
    <div className="space-y-4">
      <div><h3 className="font-semibold">Bluesky credentials</h3><p className="text-sm text-muted-foreground">Validation is read-only and never changes the account profile.</p></div>
      <Label htmlFor="new-bsky-identifier">Bluesky Identifier</Label>
      <Input id="new-bsky-identifier" data-autofocus value={props.form.bskyIdentifier} onChange={(event) => props.onFormChange((current) => ({ ...current, bskyIdentifier: event.target.value }))} required />
      <Label htmlFor="new-bsky-password">Bluesky App Password</Label>
      <Input id="new-bsky-password" type="password" value={props.form.bskyPassword} onChange={(event) => props.onFormChange((current) => ({ ...current, bskyPassword: event.target.value }))} required />
      <Label htmlFor="new-bsky-service">Bluesky Service URL</Label>
      <Input id="new-bsky-service" value={props.form.bskyServiceUrl} onChange={(event) => props.onFormChange((current) => ({ ...current, bskyServiceUrl: event.target.value }))} />
    </div>
  );
}

function ReviewStep(props: AddDestinationWizardProps) {
  const allowProfileMutation = props.form.profileManagement.allowProfileMutation;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Verify &amp; Create</h3>
      <div className="rounded-md border p-4 text-sm">
        <p><strong>Destination:</strong> @{props.form.bskyIdentifier}</p>
        <p><strong>X Sources ({props.sources.length}):</strong> {props.sources.map((source) => `@${source}`).join(', ')}</p>
        <p><strong>Backfill:</strong> None (request separately after creation)</p>
        <p><strong>Attribution:</strong> {describeAttribution(props.form.postingPolicy.attribution.mode, props.sources.length)}</p>
        <p>
          <strong>Profile &amp; pin policy:</strong>{' '}
          {allowProfileMutation ? 'Mutations allowed (sync modes still off)' : 'Mutations disabled'}
        </p>
      </div>
      <AttributionPolicyFields
        idPrefix="new-destination"
        form={props.form}
        sourceCount={props.sources.length}
        onFormChange={props.onFormChange}
      />
      <ProfileMutationField
        idPrefix="new-destination"
        form={props.form}
        sourceUsernames={props.sources}
        onFormChange={props.onFormChange}
      />
    </div>
  );
}
