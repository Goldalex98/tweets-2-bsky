import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import type { DigestAdminView, IngestionCredentialView, IngestionSourceView } from './types';

type Confirmation =
  | { kind: 'credential'; id: string; expected: string }
  | { kind: 'digest'; id: string; expected: string };

interface IngestionDigestsPageProps {
  sources: IngestionSourceView[];
  credentials: IngestionCredentialView[];
  digests: DigestAdminView;
  oneTimeSecret: string | null;
  loading: boolean;
  error: string | null;
  onCreateSource(payload: { type: 'webhook' | 'api'; name: string; destinationIds: string[] }): Promise<void>;
  onSetRouteDelivery(
    routeId: string,
    payload:
      | { mode: 'immediate' }
      | { mode: 'digest'; digest: { timezone: string; cadence: string; hour: number; minute: number } },
  ): Promise<void>;
  onCreateCredential(payload: { sourceId: string; name: string; includeHmac: boolean }): Promise<unknown>;
  onRevokeCredential(id: string, confirmation: string): Promise<void>;
  onPreviewDigest(routeId: string): Promise<unknown>;
  onPublishDigest(routeId: string): Promise<void>;
  onRetryDigest(jobId: string): Promise<void>;
  onCancelDigest(jobId: string, confirmation: string): Promise<void>;
}

export function IngestionDigestsPage(props: IngestionDigestsPageProps) {
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmationValue, setConfirmationValue] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const nonX = props.sources.filter((source) => source.type !== 'x');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="ingestion-title" aria-busy={props.loading || busy}>
      <h2 id="ingestion-title" className="sr-only">Ingestion and digests</h2>
      {props.error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{props.error}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>Normalized ingestion sources</CardTitle>
          <CardDescription>Webhook/API credentials are stored separately and never returned with source configuration.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 border-t border-border/70 pt-4">
          <Button size="sm" onClick={() => setSourceDialogOpen(true)}>Add webhook/API source</Button>
          {nonX.length === 0 ? <p className="text-sm text-muted-foreground">No webhook or API sources configured.</p> : null}
          {nonX.map((source) => (
            <div key={source.id} className="rounded-md border p-3 text-sm">
              <div className="font-medium">{source.name ?? source.username}</div>
              <div className="font-mono text-xs text-muted-foreground">{source.id}</div>
              <div className="mt-2 space-y-1">
                {source.routes.map((route) => (
                  <div key={route.id} className="flex items-center justify-between gap-2">
                    <span>Route {route.id.slice(0, 10)} · {route.delivery?.mode ?? 'immediate'}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          props.onSetRouteDelivery(
                            route.id,
                            route.delivery?.mode === 'digest'
                              ? { mode: 'immediate' }
                              : { mode: 'digest', digest: { timezone: 'UTC', cadence: 'daily', hour: 9, minute: 0 } },
                          ),
                        )
                      }
                    >
                      Use {route.delivery?.mode === 'digest' ? 'immediate' : 'digest'}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Scoped credentials</CardTitle><CardDescription>New token and HMAC values are shown once.</CardDescription></CardHeader>
        <CardContent className="space-y-3 border-t border-border/70 pt-4">
          <Button size="sm" disabled={nonX.length === 0 || busy} onClick={() => setCredentialDialogOpen(true)}>Create credential</Button>
          {props.oneTimeSecret ? <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{props.oneTimeSecret}</pre> : null}
          {props.credentials.length === 0 ? <p className="text-sm text-muted-foreground">No scoped credentials.</p> : null}
          {props.credentials.map((credential) => (
            <div key={credential.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="text-sm"><div className="font-medium">{credential.name}</div><div className="text-xs text-muted-foreground">{credential.scopes.join(', ')} · HMAC {credential.hmacEnabled ? 'on' : 'off'}</div></div>
              {!credential.revokedAt ? (
                <Button size="sm" variant="destructive" onClick={() => {
                  setConfirmation({ kind: 'credential', id: credential.id, expected: `REVOKE ${credential.id}` });
                  setConfirmationValue('');
                }}>Revoke</Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Digest jobs</CardTitle><CardDescription>{props.digests.entries.filter((entry) => entry.status === 'pending').length} pending entries.</CardDescription></CardHeader>
        <CardContent className="space-y-2 border-t border-border/70 pt-4">
          {props.digests.jobs.length === 0 ? <p className="text-sm text-muted-foreground">No digest jobs.</p> : null}
          {props.digests.jobs.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <span className="text-sm">{job.routeId} · {job.status} · attempts {job.attempts}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void run(async () => setPreview(await props.onPreviewDigest(job.routeId)))}>Preview</Button>
                <Button size="sm" onClick={() => void run(() => props.onPublishDigest(job.routeId))}>Publish now</Button>
                {job.status === 'failed' ? <Button size="sm" variant="outline" onClick={() => void run(() => props.onRetryDigest(job.id))}>Retry</Button> : null}
                {job.status !== 'processing' ? <Button size="sm" variant="destructive" onClick={() => {
                  setConfirmation({ kind: 'digest', id: job.id, expected: `CANCEL ${job.id}` });
                  setConfirmationValue('');
                }}>Cancel</Button> : null}
              </div>
            </div>
          ))}
          {preview !== null ? <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(preview, null, 2)}</pre> : null}
        </CardContent>
      </Card>

      <SourceDialog open={sourceDialogOpen} onClose={() => setSourceDialogOpen(false)} onSubmit={(payload) => run(async () => {
        await props.onCreateSource(payload);
        setSourceDialogOpen(false);
      })} />
      <CredentialDialog sources={nonX} open={credentialDialogOpen} onClose={() => setCredentialDialogOpen(false)} onSubmit={(payload) => run(async () => {
        await props.onCreateCredential(payload);
        setCredentialDialogOpen(false);
      })} />
      <Dialog open={confirmation !== null} onClose={() => setConfirmation(null)} titleId="ingestion-confirm-title" descriptionId="ingestion-confirm-description">
        <div className="w-[min(92vw,32rem)] space-y-4 rounded-lg bg-background p-5">
          <h2 id="ingestion-confirm-title" className="text-lg font-semibold">Confirm destructive action</h2>
          <p id="ingestion-confirm-description" className="text-sm text-muted-foreground">Type <strong>{confirmation?.expected}</strong> to continue.</p>
          <Input aria-label="Confirmation text" value={confirmationValue} onChange={(event) => setConfirmationValue(event.target.value)} />
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="destructive" disabled={confirmationValue !== confirmation?.expected || busy} onClick={() => void run(async () => {
            if (!confirmation) return;
            if (confirmation.kind === 'credential') await props.onRevokeCredential(confirmation.id, confirmationValue);
            else await props.onCancelDigest(confirmation.id, confirmationValue);
            setConfirmation(null);
          })}>Confirm</Button></div>
        </div>
      </Dialog>
    </section>
  );
}

function SourceDialog({ open, onClose, onSubmit }: { open: boolean; onClose(): void; onSubmit(payload: { type: 'webhook' | 'api'; name: string; destinationIds: string[] }): Promise<void> }) {
  const [type, setType] = useState<'webhook' | 'api'>('webhook');
  const [name, setName] = useState('');
  const [destinationId, setDestinationId] = useState('');
  return <Dialog open={open} onClose={onClose} titleId="source-dialog-title"><form className="w-[min(92vw,32rem)] space-y-4 rounded-lg bg-background p-5" onSubmit={(event) => { event.preventDefault(); void onSubmit({ type, name, destinationIds: destinationId ? [destinationId] : [] }); }}><h2 id="source-dialog-title" className="text-lg font-semibold">Add ingestion source</h2><Label htmlFor="source-type">Source type</Label><select id="source-type" className="h-10 w-full rounded-md border bg-background px-3" value={type} onChange={(event) => setType(event.target.value as 'webhook' | 'api')}><option value="webhook">Webhook</option><option value="api">API</option></select><Label htmlFor="source-name">Source name</Label><Input id="source-name" value={name} onChange={(event) => setName(event.target.value)} required /><Label htmlFor="source-destination">Destination id (optional)</Label><Input id="source-destination" value={destinationId} onChange={(event) => setDestinationId(event.target.value)} /><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Add source</Button></div></form></Dialog>;
}

function CredentialDialog({ sources, open, onClose, onSubmit }: { sources: IngestionSourceView[]; open: boolean; onClose(): void; onSubmit(payload: { sourceId: string; name: string; includeHmac: boolean }): Promise<void> }) {
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('Inbound publisher');
  const [includeHmac, setIncludeHmac] = useState(false);
  const selected = sourceId || sources[0]?.id || '';
  return <Dialog open={open} onClose={onClose} titleId="credential-dialog-title"><form className="w-[min(92vw,32rem)] space-y-4 rounded-lg bg-background p-5" onSubmit={(event) => { event.preventDefault(); void onSubmit({ sourceId: selected, name, includeHmac }); }}><h2 id="credential-dialog-title" className="text-lg font-semibold">Create scoped credential</h2><Label htmlFor="credential-source">Source</Label><select id="credential-source" className="h-10 w-full rounded-md border bg-background px-3" value={selected} onChange={(event) => setSourceId(event.target.value)}>{sources.map((source) => <option key={source.id} value={source.id}>{source.name || source.id}</option>)}</select><Label htmlFor="credential-name">Credential name</Label><Input id="credential-name" value={name} onChange={(event) => setName(event.target.value)} required /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeHmac} onChange={(event) => setIncludeHmac(event.target.checked)} />Require HMAC signatures</label><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit">Create credential</Button></div></form></Dialog>;
}
