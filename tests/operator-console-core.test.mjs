import { describe, expect, it, vi } from 'vitest';
import {
  OperatorConsoleClient,
  confirmationPhrase,
  eligibleAccountPairs,
  formatMoney
} from '../scripts/operator/console-core.mjs';

describe('text-mode operator console client', () => {
  it('uses the protected session, CSRF token, origin, and guarded submit body', async () => {
    const calls = [];
    const fetchImplementation = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/operator/session')) {
        return new Response(JSON.stringify({
          username: 'admin',
          role: 'admin',
          csrfToken: 'csrf-console'
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'revolut_operator_session=session-console; HttpOnly; Path=/'
          }
        });
      }
      return new Response(JSON.stringify({ id: 'transfer-1', state: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const client = new OperatorConsoleClient(fetchImplementation);
    await client.login('admin', 'secret-password');
    await client.submitTransfer('transfer-1', 'secret-password', 'SUBMIT 0.01 GBP');

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const submit = calls[1];
    expect(submit.url).toBe('http://127.0.0.1:3000/v1/sandbox/internal-transfers/transfer-1/submit');
    expect(submit.options.headers.get('cookie')).toBe('revolut_operator_session=session-console');
    expect(submit.options.headers.get('x-csrf-token')).toBe('csrf-console');
    expect(submit.options.headers.get('origin')).toBe('http://127.0.0.1:3000');
    expect(JSON.parse(submit.options.body)).toEqual({
      password: 'secret-password',
      confirmation: 'SUBMIT 0.01 GBP'
    });
  });

  it('surfaces plain-language API errors without leaking response internals', async () => {
    const client = new OperatorConsoleClient(async () => new Response(
      JSON.stringify({ error: 'This account does not have permission.' }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    ));
    await expect(client.accounts()).rejects.toThrow('This account does not have permission.');
  });

  it('finds eligible pairs and formats the server confirmation phrase', () => {
    const accounts = [
      { id: 'one', name: 'One', currency: 'GBP', balanceMinor: 100, state: 'active' },
      { id: 'two', name: 'Two', currency: 'GBP', balanceMinor: 100, state: 'active' },
      { id: 'three', name: 'Three', currency: 'EUR', balanceMinor: 100, state: 'active' }
    ];
    expect(eligibleAccountPairs(accounts)).toHaveLength(2);
    expect(confirmationPhrase({
      state: 'prepared',
      amountMinor: 1,
      currency: 'GBP',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z'
    })).toBe('SUBMIT 0.01 GBP');
    expect(formatMoney(1, 'GBP')).toContain('0.01');
  });
});
