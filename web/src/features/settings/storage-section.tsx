import { Database, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

interface StorageReport {
  databaseBytes: number;
  walBytes: number;
  historyRetentionDays: number;
  tables: Array<{ name: string; rows: number }>;
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Database size, rows per table, and a manual prune of operational history. */
export function StorageSection() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [days, setDays] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<StorageReport>('/api/admin/storage');
      setReport(response.data);
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Failed to load storage details.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedDays = Number(days || report?.historyRetentionDays || 90);
  const validDays = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 3650;

  const prune = async () => {
    setBusy(true);
    try {
      const response = await api.post<{ pruned: Record<string, number>; report: StorageReport }>(
        '/api/admin/storage/prune',
        { olderThanDays: parsedDays, confirmation: 'PRUNE_HISTORY' },
      );
      const removed = Object.values(response.data.pruned ?? {}).reduce((sum, count) => sum + count, 0);
      setReport(response.data.report);
      setNotice(`Removed ${removed} row${removed === 1 ? '' : 's'} older than ${parsedDays} days.`);
      setError(null);
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, 'Failed to prune history.'));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const tables = Array.isArray(report?.tables) ? report.tables : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          Database size and rows per table. Pruning removes ingestion audit, AI usage, webhook delivery and expired
          nonce rows; posting history and the queue are never pruned.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 border-t pt-4">
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {notice ? <output className="block text-sm text-muted-foreground">{notice}</output> : null}
        {report ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Database</p>
                <p className="mt-1 text-lg font-semibold">{formatBytes(report.databaseBytes)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Write-ahead log</p>
                <p className="mt-1 text-lg font-semibold">{formatBytes(report.walBytes)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Automatic pruning</p>
                <p className="mt-1 text-lg font-semibold">
                  {report.historyRetentionDays > 0 ? `After ${report.historyRetentionDays} days` : 'Off'}
                </p>
              </div>
            </div>
            <table className="w-full text-sm">
              <caption className="sr-only">Rows per table</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-1 font-medium">
                    Table
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Rows
                  </th>
                </tr>
              </thead>
              <tbody>
                {tables.map((table) => (
                  <tr key={table.name} className="border-t border-border/60">
                    <td className="py-1 font-mono text-xs">{table.name}</td>
                    <td className="py-1 text-right tabular-nums">{table.rows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="storage-prune-days">Prune history older than (days)</Label>
                <Input
                  id="storage-prune-days"
                  type="number"
                  min={1}
                  max={3650}
                  className="w-32"
                  placeholder={String(report.historyRetentionDays || 90)}
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
              </div>
              <Button variant="destructive" onClick={() => setConfirming(true)} disabled={busy || !validDays}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                Prune now
              </Button>
            </div>
          </>
        ) : !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Database className="h-4 w-4" />
            Loading storage details…
          </p>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        title="Prune operational history?"
        description={`Permanently delete ingestion audit, AI usage and webhook delivery rows older than ${parsedDays} days. Posting history and the queue are kept.`}
        confirmLabel="Prune history"
        destructive
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void prune()}
      />
    </Card>
  );
}
