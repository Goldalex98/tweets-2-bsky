import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { AccountMapping } from './types';

interface MigrationReviewPanelProps {
  mapping: AccountMapping;
  canReview: boolean;
  busy: boolean;
  onDismiss(): void;
}

export function MigrationReviewPanel({ mapping, canReview, busy, onDismiss }: MigrationReviewPanelProps) {
  const review = mapping.migrationReview;
  if (!review) {
    return <p className="text-sm text-muted-foreground">No migration notices for this destination.</p>;
  }

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">Migration review</p>
        <Badge variant={review.needsAdminReview ? 'outline' : 'success'}>
          {review.needsAdminReview ? 'Pending review' : 'Reviewed'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Migrated from schema version {review.migratedFromSchemaVersion}.
        {review.reviewedAt ? ` Reviewed at ${new Date(review.reviewedAt).toLocaleString()}.` : ''}
      </p>
      {review.notices.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {review.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}
      {review.needsAdminReview ? (
        canReview ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onDismiss}>
            Mark as reviewed
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            An administrator must dismiss this migration notice.
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground">This migration notice has been acknowledged.</p>
      )}
    </div>
  );
}
