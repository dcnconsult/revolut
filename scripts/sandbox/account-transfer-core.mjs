import { randomUUID } from 'node:crypto';

export const DEFAULT_SANDBOX_TRANSFER_AMOUNT = 0.01;
export const MAX_SANDBOX_TRANSFER_AMOUNT = 10;
export const SANDBOX_TRANSFER_REFERENCE = 'SANDBOX ACCOUNT TRANSFER TEST';

export function parseSandboxTransferAmount(value = DEFAULT_SANDBOX_TRANSFER_AMOUNT) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > MAX_SANDBOX_TRANSFER_AMOUNT) {
    throw new Error(`Sandbox transfer amount must be between 0.01 and ${MAX_SANDBOX_TRANSFER_AMOUNT}.`);
  }
  return Math.round(amount * 100) / 100;
}

export function findEligibleAccountPairs(accounts, amount = DEFAULT_SANDBOX_TRANSFER_AMOUNT) {
  const normalizedAmount = parseSandboxTransferAmount(amount);
  const active = accounts.filter(account =>
    account?.state === 'active' &&
    typeof account.id === 'string' &&
    typeof account.currency === 'string'
  );

  return active.flatMap(source =>
    active
      .filter(target =>
        target.id !== source.id &&
        target.currency === source.currency &&
        Number(source.balance) >= normalizedAmount
      )
      .map(target => ({ source, target, currency: source.currency }))
  );
}

export function buildAccountTransferPayload({
  source,
  target,
  amount = DEFAULT_SANDBOX_TRANSFER_AMOUNT,
  requestId = randomUUID()
}) {
  const normalizedAmount = parseSandboxTransferAmount(amount);
  if (!source?.id || !target?.id) throw new Error('Both Sandbox accounts must have an ID.');
  if (source.id === target.id) throw new Error('Source and target Sandbox accounts must be different.');
  if (!source.currency || source.currency !== target.currency) {
    throw new Error('Revolut account transfers require source and target accounts in the same currency.');
  }
  if (source.state !== 'active' || target.state !== 'active') {
    throw new Error('Both Sandbox accounts must be active.');
  }
  if (Number(source.balance) < normalizedAmount) {
    throw new Error('The selected Sandbox source account does not have enough test funds.');
  }
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('The Sandbox transfer request ID must be a UUID.');
  }

  return {
    request_id: requestId,
    source_account_id: source.id,
    target_account_id: target.id,
    amount: normalizedAmount,
    currency: source.currency,
    reference: SANDBOX_TRANSFER_REFERENCE
  };
}

export function sanitizeTransferResult(result, payload, executed) {
  return {
    execution: executed ? 'EXECUTED' : 'DRY_RUN',
    state: executed ? String(result?.state ?? 'unknown') : 'not_submitted',
    amount: payload.amount,
    currency: payload.currency,
    host: 'sandbox-b2b.revolut.com',
    permission: executed ? 'PAY' : 'PAY_required',
    liveData: false
  };
}
