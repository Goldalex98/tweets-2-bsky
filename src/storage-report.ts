import fs from 'node:fs';
import { databaseStorageService } from './db.js';
import { DB_PATH } from './storage-paths.js';

export const HISTORY_RETENTION_MAX_DAYS = 3650;

/** `HISTORY_RETENTION_DAYS`, default 90; 0 turns automatic pruning off. */
export function historyRetentionDays(raw = process.env.HISTORY_RETENTION_DAYS): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(value)) return 90;
  return Math.min(HISTORY_RETENTION_MAX_DAYS, Math.max(0, Math.round(value)));
}

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

export function buildStorageReport(): StorageReport {
  return {
    databaseBytes: fileBytes(DB_PATH),
    walBytes: fileBytes(`${DB_PATH}-wal`),
    historyRetentionDays: historyRetentionDays(),
    tables: databaseStorageService.tableRowCounts(),
  };
}
