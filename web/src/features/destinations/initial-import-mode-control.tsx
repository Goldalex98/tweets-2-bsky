import { Label } from '../../components/ui/label';
import { selectClassName } from '../../lib/dashboard-utils';
import type { DefaultInitialImportMode, InitialImportMode } from './types';

export function describeInitialImportDefault(mode: DefaultInitialImportMode): string {
  return mode === 'recent' ? 'Import recent existing posts' : 'Start with new posts only';
}

interface InitialImportModeControlProps {
  id: string;
  value: InitialImportMode;
  globalDefault: DefaultInitialImportMode;
  onChange(value: InitialImportMode): void;
  disabled?: boolean;
  label?: string;
  compactHelp?: boolean;
}

export function InitialImportModeControl({
  id,
  value,
  globalDefault,
  onChange,
  disabled = false,
  label = 'Initial import',
  compactHelp = false,
}: InitialImportModeControlProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClassName}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as InitialImportMode)}
      >
        <option value="inherit">Use global default — {describeInitialImportDefault(globalDefault)}</option>
        <option value="recent">Import recent existing posts</option>
        <option value="new-only">Start with new posts only</option>
      </select>
      <p className="text-xs text-muted-foreground">
        {value === 'inherit'
          ? `Current global default: ${describeInitialImportDefault(globalDefault)}.`
          : value === 'recent'
            ? 'The first successful scan may queue recent existing posts.'
            : 'The first successful scan records a baseline without queuing existing posts.'}
      </p>
      {!compactHelp ? (
        <p className="text-xs text-muted-foreground">
          This controls only the first scan of a newly added account. Changing it after initialization does not import
          history; use Backfill to import older posts later.
        </p>
      ) : null}
    </div>
  );
}
