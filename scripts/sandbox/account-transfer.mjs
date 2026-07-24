import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_SANDBOX_TRANSFER_AMOUNT,
  buildAccountTransferPayload,
  findEligibleAccountPairs,
  parseSandboxTransferAmount,
  sanitizeTransferResult
} from './account-transfer-core.mjs';
import { formatFailure, getAccounts, sandboxApiRequest } from './shared.mjs';

export async function runInteractiveAccountTransfer({
  execute = process.argv.includes('--execute'),
  amount = readAmountArgument(process.argv) ?? DEFAULT_SANDBOX_TRANSFER_AMOUNT
} = {}) {
  const normalizedAmount = parseSandboxTransferAmount(amount);
  console.log('REVOLUTE — Sandbox account-to-account transfer test');
  console.log('Locked to https://sandbox-b2b.revolut.com. Production is refused.');
  console.log(execute
    ? 'EXECUTE mode: this will move test funds only inside Revolut Sandbox.'
    : 'DRY-RUN mode: no transfer will be submitted.');

  const accounts = await getAccounts();
  const pairs = findEligibleAccountPairs(accounts, normalizedAmount);
  if (pairs.length === 0) {
    throw new Error(
      `No two active same-currency Sandbox accounts can transfer ${normalizedAmount.toFixed(2)}. ` +
      'Create another account in the same currency or add Sandbox test funds.'
    );
  }

  const selected = pairs[0];
  const payload = buildAccountTransferPayload({
    source: selected.source,
    target: selected.target,
    amount: normalizedAmount
  });

  console.table([{
    From: selected.source.name ?? '(Sandbox account)',
    To: selected.target.name ?? '(Sandbox account)',
    Amount: payload.amount,
    Currency: payload.currency,
    Mode: execute ? 'EXECUTE' : 'DRY RUN'
  }]);

  if (!execute) {
    const summary = sanitizeTransferResult(undefined, payload, false);
    printResult('SANDBOX_TRANSFER_READY', summary);
    return summary;
  }

  const rl = createInterface({ input, output });
  try {
    const phrase = `TRANSFER ${payload.amount.toFixed(2)} ${payload.currency} IN SANDBOX`;
    console.log(`Type exactly: ${phrase}`);
    const confirmation = (await rl.question('Confirmation: ')).trim();
    if (confirmation !== phrase) throw new Error('Sandbox transfer cancelled.');
  } finally {
    rl.close();
  }

  const result = await sandboxApiRequest('/transfer', {
    method: 'POST',
    scopesDescription: 'PAY',
    body: payload
  });
  const summary = sanitizeTransferResult(result, payload, true);
  printResult('SANDBOX_TRANSFER_OK', summary);
  return summary;
}

function readAmountArgument(args) {
  const argument = args.find(value => value.startsWith('--amount='));
  return argument?.slice('--amount='.length);
}

function printResult(prefix, summary) {
  console.log([
    prefix,
    `execution=${summary.execution}`,
    `state=${summary.state}`,
    `amount=${summary.amount.toFixed(2)}`,
    `currency=${summary.currency}`,
    `host=${summary.host}`,
    `permission=${summary.permission}`,
    `live_data=${summary.liveData}`
  ].join(' '));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  runInteractiveAccountTransfer().catch(error => {
    console.error(`SANDBOX_TRANSFER_STOPPED\n${formatFailure(error)}`);
    process.exitCode = 1;
  });
}
