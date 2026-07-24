import { describe, expect, it, vi } from 'vitest';
import {
  buildAccountTransferPayload,
  findEligibleAccountPairs,
  parseSandboxTransferAmount,
  sanitizeTransferResult
} from '../scripts/sandbox/account-transfer-core.mjs';
import { runDropletTransferTest } from '../scripts/sandbox/droplet-transfer.mjs';

const gbpSource = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'GBP source',
  currency: 'GBP',
  balance: 20,
  state: 'active'
};
const gbpTarget = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'GBP target',
  currency: 'GBP',
  balance: 5,
  state: 'active'
};
const requestId = '33333333-3333-4333-8333-333333333333';
const sandboxConfig = {
  baseUrl: 'https://sandbox-b2b.revolut.com/api/1.0'
};

describe('Sandbox account transfer safeguards', () => {
  it('allows only small two-decimal Sandbox amounts', () => {
    expect(parseSandboxTransferAmount('0.01')).toBe(0.01);
    expect(parseSandboxTransferAmount('1.239')).toBe(1.24);
    expect(() => parseSandboxTransferAmount(0)).toThrow(/between 0.01 and 10/);
    expect(() => parseSandboxTransferAmount(10.01)).toThrow(/between 0.01 and 10/);
  });

  it('selects only distinct active same-currency accounts with enough test funds', () => {
    const pairs = findEligibleAccountPairs([
      gbpSource,
      gbpTarget,
      { id: 'eur', currency: 'EUR', balance: 100, state: 'active' },
      { id: 'inactive', currency: 'GBP', balance: 100, state: 'inactive' }
    ], 10);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ source: gbpSource, target: gbpTarget, currency: 'GBP' });
  });

  it('builds the documented POST /transfer body with an idempotent UUID', () => {
    expect(buildAccountTransferPayload({
      source: gbpSource,
      target: gbpTarget,
      amount: 0.01,
      requestId
    })).toEqual({
      request_id: requestId,
      source_account_id: gbpSource.id,
      target_account_id: gbpTarget.id,
      amount: 0.01,
      currency: 'GBP',
      reference: 'SANDBOX ACCOUNT TRANSFER TEST'
    });
  });

  it('defaults the Droplet test to a non-mutating dry run', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse([gbpSource, gbpTarget])
    );
    const result = await runDropletTransferTest(sandboxConfig, {
      amount: 0.01,
      accessToken: 'sandbox-test-token',
      fetchImplementation
    });
    expect(result).toEqual({
      execution: 'DRY_RUN',
      state: 'not_submitted',
      amount: 0.01,
      currency: 'GBP',
      host: 'sandbox-b2b.revolut.com',
      permission: 'PAY_required',
      liveData: false
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls[0][0]).toBe(
      'https://sandbox-b2b.revolut.com/api/1.0/accounts'
    );
  });

  it('posts only to the exact Sandbox transfer endpoint when explicitly enabled', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(jsonResponse([gbpSource, gbpTarget]))
      .mockResolvedValueOnce(jsonResponse({ id: 'transfer-id', state: 'completed' }));

    const result = await runDropletTransferTest(sandboxConfig, {
      amount: 0.01,
      execute: true,
      requestId,
      accessToken: 'sandbox-test-token',
      fetchImplementation
    });
    expect(result).toEqual(sanitizeTransferResult(
      { id: 'transfer-id', state: 'completed' },
      buildAccountTransferPayload({ source: gbpSource, target: gbpTarget, amount: 0.01, requestId }),
      true
    ));
    expect(fetchImplementation.mock.calls[1][0]).toBe(
      'https://sandbox-b2b.revolut.com/api/1.0/transfer'
    );
    expect(fetchImplementation.mock.calls[1][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(fetchImplementation.mock.calls[1][1].body)).toMatchObject({
      request_id: requestId,
      amount: 0.01,
      currency: 'GBP'
    });
  });

  it('refuses a production base URL even if execution is requested', async () => {
    await expect(runDropletTransferTest(
      { baseUrl: 'https://b2b.revolut.com/api/1.0' },
      {
        execute: true,
        accessToken: 'test-token',
        fetchImplementation: vi.fn()
      }
    )).rejects.toThrow('Refusing non-Sandbox API URL');
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}
