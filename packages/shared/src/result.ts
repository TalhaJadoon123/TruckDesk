/**
 * Result type. Domain code never throws for expected failures - a refused
 * dispatch, an illegal status change, an unfunded plan all return `err`.
 */
export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E = DomainError> {
  ok: false;
  error: E;
}

export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Map over the success channel, pass the failure through untouched. */
export function mapResult<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Unwrap or throw. Only for tests, CLI entry points and top-level handlers. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  const message = r.error instanceof Error ? r.error.message : JSON.stringify(r.error);
  throw new Error(`unwrap() called on Err: ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'PLAN_LIMIT'
  | 'HOS_VIOLATION'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'EXTERNAL_SERVICE'
  | 'INTERNAL';

export interface DomainErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
  /** HTTP status the API layer should surface. */
  status?: number;
}

/** Error carrying a machine-readable code so routes can map it to a status. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.details = options.details;
    this.status = options.status ?? defaultStatusFor(code);
  }

  toJSON(): { code: DomainErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function defaultStatusFor(code: DomainErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_INPUT':
      return 400;
    case 'INVALID_STATE':
      return 409;
    case 'CONFLICT':
      return 409;
    case 'FORBIDDEN':
      return 403;
    case 'PLAN_LIMIT':
      return 402;
    case 'HOS_VIOLATION':
      return 409;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    case 'EXTERNAL_SERVICE':
      return 502;
    default:
      return 500;
  }
}

export const Errors = {
  notFound: (what: string, id?: string) =>
    new DomainError('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`, {
      details: id ? { id } : undefined,
    }),
  /** 401. Kept distinct from forbidden so clients can tell "log in" from "no". */
  unauthorized: (message: string, details?: Record<string, unknown>) =>
    new DomainError('FORBIDDEN', message, { details, status: 401 }),
  invalidState: (message: string, details?: Record<string, unknown>) =>
    new DomainError('INVALID_STATE', message, { details }),
  invalidInput: (message: string, details?: Record<string, unknown>) =>
    new DomainError('INVALID_INPUT', message, { details }),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new DomainError('CONFLICT', message, { details }),
  forbidden: (message: string, details?: Record<string, unknown>) =>
    new DomainError('FORBIDDEN', message, { details }),
  planLimit: (message: string, details?: Record<string, unknown>) =>
    new DomainError('PLAN_LIMIT', message, { details }),
  hosViolation: (message: string, details?: Record<string, unknown>) =>
    new DomainError('HOS_VIOLATION', message, { details }),
  external: (service: string, message: string, cause?: unknown) =>
    new DomainError('EXTERNAL_SERVICE', `${service}: ${message}`, { cause }),
  unavailable: (what: string, cause?: unknown) =>
    new DomainError('DEPENDENCY_UNAVAILABLE', `${what} is not available`, { cause }),
  internal: (message: string, cause?: unknown) =>
    new DomainError('INTERNAL', message, { cause }),
};