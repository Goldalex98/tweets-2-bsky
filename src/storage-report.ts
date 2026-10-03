import fs from 'node:fs';
import { databaseStorageService } from './db.js';
import { historyRetentionDays } from './history-retention.js';
import { DB_PATH } from './storage-paths.js';

const fileBytes = (filePath: string): number => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

export interface StorageReport {
  databaseBytes: number;
  walBytes: number;
  historyRetentionDays: number;
  tables: Array<{ name: string; rows: number }>;
}

const REPORT_CACHE_MS = 30_000;
let cached: { at: number; report: StorageReport } | undefined;

/** Counting every table scans it, so a report is reused for 30 seconds unless `fresh` is set. */
export function buildStorageReport(options: { fresh?: boolean; now?: number } = {}): StorageReport {
  const now = options.now ?? Date.now();
  if (!options.fresh && cached && now - cached.at < REPORT_CACHE_MS) return cached.report;
  const report: StorageReport = {
    databaseBytes: fileBytes(DB_PATH),
    walBytes: fileBytes(`${DB_PATH}-wal`),
    historyRetentionDays: historyRetentionDays(),
    tables: databaseStorageService.tableRowCounts(),
  };
  cached = { at: now, report };
  return report;
}
