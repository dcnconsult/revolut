import { createHash } from 'node:crypto';

export type OperationalErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'validation'
  | 'conflict'
  | 'rate_limit'
  | 'provider_unavailable'
  | 'network'
  | 'invalid_response'
  | 'internal';

export type OperationalErrorSeverity = 'warning' | 'critical';

export interface OperationalErrorInput {
  fingerprint: string;
  category: OperationalErrorCategory;
  severity: OperationalErrorSeverity;
  operation: string;
  safeMessage: string;
  retryable: boolean;
  httpStatus?: number;
  context: Record<string, string | number | boolean>;
  occurredAt: string;
}

export interface OperationalErrorRecord extends OperationalErrorInput {
  id: number;
  occurrenceCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  resolvedAt?: string;
}

export interface OperationalErrorReport {
  health: 'clear' | 'degraded' | 'blocked';
  unresolved: number;
  critical: number;
  warning: number;
  retryable: number;
  totalOccurrences: number;
  byCategory: Record<string, number>;
  latestOccurredAt?: string;
  generatedAt: string;
}

export interface OperationalErrorPersistence {
  recordOperationalError(error: OperationalErrorInput): void;
  resolveOperationalErrors(operation: string, resolvedAt: string): void;
  listOperationalErrors(limit: number): OperationalErrorRecord[];
  operationalErrorReport(): OperationalErrorReport;
}

interface FaultOptions {
  category: OperationalErrorCategory;
  severity?: OperationalErrorSeverity;
  retryable: boolean;
  httpStatus?: number;
}

export class OperationalFault extends Error {
  readonly category: OperationalErrorCategory;
  readonly severity: OperationalErrorSeverity;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;

  constructor(message: string, options: FaultOptions) {
    super(message);
    this.name = 'OperationalFault';
    this.category = options.category;
    this.severity = options.severity ?? (options.retryable ? 'warning' : 'critical');
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
  }
}

export class OperationalErrorMonitor {
  constructor(private readonly persistence: OperationalErrorPersistence) {}

  async capture<T>(
    operation: string,
    action: () => Promise<T>,
    context: Record<string, string | number | boolean> = {}
  ) {
    try {
      const result = await action();
      this.persistence.resolveOperationalErrors(operation, new Date().toISOString());
      return result;
    } catch (error) {
      this.record(operation, error, context);
      throw error;
    }
  }

  record(
    operation: string,
    error: unknown,
    context: Record<string, string | number | boolean> = {}
  ) {
    const classified = classifyOperationalError(error);
    const safeMessage = redactOperationalMessage(
      error instanceof Error ? error.message : 'An unknown operational error occurred.'
    );
    const fingerprint = createHash('sha256')
      .update([
        operation,
        classified.category,
        classified.httpStatus ?? '',
        safeMessage
      ].join('|'))
      .digest('hex');
    const safeContext = Object.fromEntries(Object.entries(context).map(([key, value]) => {
      if (/(?:authorization|password|secret|token|certificate|private.?key|account.?id|transfer.?id)/i.test(key)) {
        return [key, '[redacted]'];
      }
      return [key, typeof value === 'string' ? redactOperationalMessage(value) : value];
    }));
    this.persistence.recordOperationalError({
      fingerprint,
      operation,
      safeMessage,
      context: safeContext,
      occurredAt: new Date().toISOString(),
      ...classified
    });
  }

  list(limit: number) {
    return this.persistence.listOperationalErrors(limit);
  }

  report() {
    return this.persistence.operationalErrorReport();
  }
}

export function classifyOperationalError(error: unknown): {
  category: OperationalErrorCategory;
  severity: OperationalErrorSeverity;
  retryable: boolean;
  httpStatus?: number;
} {
  if (error instanceof OperationalFault) {
    return {
      category: error.category,
      severity: error.severity,
      retryable: error.retryable,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus })
    };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('idempotency conflict')) {
    return { category: 'conflict', severity: 'warning', retryable: false };
  }
  if (message.includes('invalid') || message.includes('required') ||
      message.includes('must ') || message.includes('exceeds') ||
      message.includes('insufficient')) {
    return { category: 'validation', severity: 'warning', retryable: false };
  }
  if (message.includes('token') || message.includes('credential') ||
      message.includes('certificate') || message.includes('authorized')) {
    return { category: 'authentication', severity: 'critical', retryable: false };
  }
  if (message.includes('timeout') || message.includes('network') || message.includes('fetch')) {
    return { category: 'network', severity: 'critical', retryable: true };
  }
  return { category: 'internal', severity: 'critical', retryable: false };
}

export function classifyHttpStatus(status: number): FaultOptions {
  if (status === 400 || status === 405 || status === 406 || status === 422) {
    return { category: 'validation', severity: 'warning', retryable: false, httpStatus: status };
  }
  if (status === 401) {
    return { category: 'authentication', severity: 'critical', retryable: false, httpStatus: status };
  }
  if (status === 403) {
    return { category: 'authorization', severity: 'critical', retryable: false, httpStatus: status };
  }
  if (status === 404 || status === 409) {
    return { category: 'conflict', severity: 'warning', retryable: false, httpStatus: status };
  }
  if (status === 429) {
    return { category: 'rate_limit', severity: 'warning', retryable: true, httpStatus: status };
  }
  if (status >= 500) {
    return { category: 'provider_unavailable', severity: 'critical', retryable: true, httpStatus: status };
  }
  return { category: 'invalid_response', severity: 'critical', retryable: false, httpStatus: status };
}

export function redactOperationalMessage(message: string) {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:access|refresh|client[_ -]?assertion)[_ -]?token\s*[:=]\s*\S+/gi, '[redacted token]')
    .replace(/[?&](?:code|token|client_assertion|refresh_token)=[^&\s]+/gi, '?[redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .slice(0, 500);
}
