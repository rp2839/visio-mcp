import type { EntityChange, TransactionSummary } from '../model/types';
import type { Source } from '../model/types';

export type HistoryRecord = {
  transactionId: string;
  source: Source;
  description: string;
  previousRevision: number;
  revision: number;
  /** Resolved forward changes; inverse is derived by swapping before/after. Null once evicted. */
  changes: EntityChange[] | null;
  summary: TransactionSummary;
};

export const HISTORY_SUMMARY_LIMIT = 1000;
export const HISTORY_INVERSE_LIMIT = 200;

export function summarise(transactionId: string, source: Source, revision: number, description: string, changes: EntityChange[], timestamp: string): TransactionSummary {
  const created: string[] = [], changed: string[] = [], deleted: string[] = [], nonElementChanges: string[] = [];
  for (const c of changes) {
    if (c.entity !== 'element') { nonElementChanges.push(`${c.entity}:${c.id}`); continue; }
    if (c.before === null) created.push(c.id);
    else if (c.after === null) deleted.push(c.id);
    else changed.push(c.id);
  }
  return { transactionId, source, revision, description, created, changed, deleted, nonElementChanges, timestamp };
}

/**
 * Linear undo/redo over resolved changes. Only the global stack head can be undone
 * (no selective undo across later edits). Undo/redo commit as new revisions.
 */
export class History {
  private records: HistoryRecord[] = [];
  private undoStack: HistoryRecord[] = [];
  private redoStack: HistoryRecord[] = [];

  push(record: HistoryRecord) {
    this.records.push(record);
    if (record.source === 'undo') {
      this.redoStack.push(this.undoStack.pop()!);
    } else if (record.source === 'redo') {
      this.undoStack.push(this.redoStack.pop()!);
    } else {
      this.undoStack.push(record);
      this.redoStack = [];
    }
    if (this.records.length > HISTORY_SUMMARY_LIMIT) this.records.splice(0, this.records.length - HISTORY_SUMMARY_LIMIT);
    // Byte/count pressure evicts the oldest inverse records first.
    const withChanges = this.records.filter((r) => r.changes !== null);
    for (let i = 0; i < withChanges.length - HISTORY_INVERSE_LIMIT; i++) withChanges[i].changes = null;
  }

  undoHead(): HistoryRecord | undefined { return this.undoStack[this.undoStack.length - 1]; }
  redoHead(): HistoryRecord | undefined { return this.redoStack[this.redoStack.length - 1]; }
  canUndo(transactionId?: string) {
    const h = this.undoHead();
    return !!h && h.changes !== null && (transactionId === undefined || h.transactionId === transactionId);
  }
  canRedo() { const h = this.redoHead(); return !!h && h.changes !== null; }

  summaries(): TransactionSummary[] { return this.records.map((r) => r.summary); }
  earliestRetainedRevision(current: number): number {
    return this.records.length ? this.records[0].previousRevision : current;
  }
}
