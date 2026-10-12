export interface NcellErrorOptions {
  code?: string;
  status?: number;
  response?: unknown;
  cause?: unknown;
}

export class NcellError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly response: unknown;

  constructor(message: string, options: NcellErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NcellError';
    this.code = options.code ?? 'INVALID_INPUT';
    this.status = options.status;
    this.response = options.response;
  }
}

export function invalidResponse(): NcellError {
  return new NcellError('Ncell returned an invalid response', { code: 'INVALID_RESPONSE' });
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidResponse();
  return value;
}

export function normalizeNumber(input: string): string {
  const number = input.startsWith('+977') ? input.slice(4) : input;
  if (!/^9\d{9}$/.test(number)) {
    throw new NcellError('Use a 10-digit Nepal mobile number, optionally prefixed with +977');
  }
  return number;
}
