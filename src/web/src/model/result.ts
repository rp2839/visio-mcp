import type { AppError, ErrorCode } from './types';

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['not_ready', 'revision_conflict', 'busy', 'busy_user_editing', 'timeout_unknown', 'io_error']);

export function err<T = never>(code: ErrorCode, message: string, details?: Record<string, unknown>, outcome?: 'not_applied' | 'unknown'): Result<T> {
  const error: AppError = { code, message, retryable: RETRYABLE.has(code) };
  if (outcome) error.outcome = outcome;
  if (details) error.details = details;
  return { ok: false, error };
}

/** Thrown inside planners to abort a whole candidate; converted to a Result at the engine boundary. */
export class PlanError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
  toResult<T>(): Result<T> {
    return err(this.code, this.message, this.details, 'not_applied');
  }
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new PlanError(code, message, details);
}
