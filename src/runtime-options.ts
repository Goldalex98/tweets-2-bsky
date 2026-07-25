import { Command } from 'commander';

export interface RuntimeOptions {
  dryRun: boolean;
  web: boolean;
  runOnce: boolean;
  backfillMapping?: string;
  backfillLimit?: number;
  importHistory?: boolean;
  username?: string;
  limit?: number;
  bypassFilters: boolean;
}

export function createRuntimeCommand(): Command {
  return new Command()
    .name('tweets-2-bsky')
    .description('Crosspost tweets to Bluesky')
    .option('--dry-run', 'Fetch tweets but do not post to Bluesky', false)
    .option('--bypass-filters', 'Bypass source filters (requires --dry-run)', false)
    .option('--no-web', 'Disable the web interface')
    .option('--run-once', 'Run one check cycle immediately and exit', false)
    .option('--backfill-mapping <mapping>', 'Run backfill now for a mapping id/handle/twitter username')
    .option('--backfill-limit <number>', 'Limit for --backfill-mapping', (value) => Number.parseInt(value, 10))
    .option('--import-history', 'Run in history import mode')
    .option('--username <username>', 'Twitter username for history import')
    .option('--limit <number>', 'Limit the number of tweets to import', (value) => Number.parseInt(value, 10));
}

export function parseRuntimeOptions(argv: string[] = process.argv): RuntimeOptions {
  const from = argv === process.argv ? 'node' : 'user';
  return createRuntimeCommand().parse(argv, { from }).opts<RuntimeOptions>();
}
