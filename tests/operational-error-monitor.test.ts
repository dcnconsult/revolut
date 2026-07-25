import { describe, expect, it } from 'vitest';
import {
  OperationalErrorMonitor,
  OperationalFault,
  redactOperationalMessage
} from '../src/operations/operational-error-monitor.js';
import { SQLiteSandboxTransferStore } from '../src/storage/sandbox-transfer-store.js';

describe('operational error monitor', () => {
  it('redacts, consolidates, persists, reports, and resolves repeated failures', async () => {
    const store = new SQLiteSandboxTransferStore(':memory:');
    const monitor = new OperationalErrorMonitor(store);
    const failingAction = () => Promise.reject(new OperationalFault(
      'Revolut request for 11111111-1111-4111-8111-111111111111 failed with Bearer secret-token-value',
      {
        category: 'provider_unavailable',
        severity: 'critical',
        retryable: true,
        httpStatus: 503
      }
    ));

    await expect(monitor.capture('accounts_list', failingAction, {
      environment: 'sandbox',
      accessToken: 'must-not-be-stored'
    })).rejects.toThrow();
    await expect(monitor.capture('accounts_list', failingAction, {
      environment: 'sandbox',
      accessToken: 'must-not-be-stored'
    })).rejects.toThrow();

    const [record] = monitor.list(10);
    expect(record).toMatchObject({
      category: 'provider_unavailable',
      severity: 'critical',
      operation: 'accounts_list',
      retryable: true,
      httpStatus: 503,
      occurrenceCount: 2
    });
    expect(record?.safeMessage).toContain('[id]');
    expect(record?.safeMessage).toContain('Bearer [redacted]');
    expect(record?.safeMessage).not.toContain('11111111');
    expect(record?.safeMessage).not.toContain('secret-token-value');
    expect(record?.context).toEqual({ environment: 'sandbox', accessToken: '[redacted]' });
    expect(monitor.report()).toMatchObject({
      health: 'blocked',
      unresolved: 1,
      critical: 1,
      totalOccurrences: 2
    });

    await monitor.capture('accounts_list', async () => 'ok');
    expect(monitor.report()).toMatchObject({ health: 'clear', unresolved: 0 });
    expect(monitor.list(10)[0]?.resolvedAt).toBeTruthy();
    store.close();
  });

  it('removes OAuth query secrets and long opaque values', () => {
    const message = redactOperationalMessage(
      'callback?code=secret-code&token=secret-token refresh_token=abcdefghijklmnopqrstuvwxyz1234567890'
    );
    expect(message).not.toContain('secret-code');
    expect(message).not.toContain('secret-token');
    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
