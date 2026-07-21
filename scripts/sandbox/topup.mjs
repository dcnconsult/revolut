import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { formatFailure, getAccounts, printAccounts, sandboxApiRequest } from './shared.mjs';

const rl = createInterface({ input, output });

try {
  console.log('REVOLUTE — Sandbox test-account top-up');
  console.log('This command is locked to the Revolut Sandbox API.');
  const accounts = await getAccounts();
  const activeAccounts = accounts.filter(account => account.state === 'active');
  if (activeAccounts.length === 0) throw new Error('No active Sandbox accounts were returned.');

  printAccounts(activeAccounts);
  const selected = await chooseAccount(activeAccounts);
  const amount = await chooseAmount();
  const referenceInput = (await rl.question('Reference [REVOLUTE Sandbox test]: ')).trim();
  const reference = referenceInput || 'REVOLUTE Sandbox test';

  console.log(`\nAbout to add ${amount} ${selected.currency} of TEST funds to ${selected.name ?? selected.id}.`);
  const confirmation = (await rl.question('Type TOPUP to continue: ')).trim();
  if (confirmation !== 'TOPUP') throw new Error('Top-up cancelled.');

  const result = await sandboxApiRequest('/sandbox/topup', {
    method: 'POST',
    scopesDescription: 'WRITE',
    body: {
      account_id: selected.id,
      amount,
      currency: selected.currency,
      reference,
      state: 'completed'
    }
  });

  console.log('\nSandbox top-up response:');
  console.table([{
    Transaction: result.id ?? '',
    State: result.state ?? '',
    Created: result.created_at ?? '',
    Completed: result.completed_at ?? ''
  }]);
  console.log('\nUpdated Sandbox account list:');
  printAccounts(await getAccounts());
  console.log('\nSUCCESS: test funds were simulated in Sandbox only.');
} catch (error) {
  console.error(`\nTOP-UP STOPPED\n${formatFailure(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

async function chooseAccount(accounts) {
  while (true) {
    const answer = Number((await rl.question(`Choose account number 1-${accounts.length}: `)).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= accounts.length) return accounts[answer - 1];
    console.log('Please type one of the account numbers shown in the first column.');
  }
}

async function chooseAmount() {
  while (true) {
    const answer = (await rl.question('Test amount, from 0.01 to 10000: ')).trim();
    const amount = Number(answer);
    if (Number.isFinite(amount) && amount >= 0.01 && amount <= 10_000) return amount;
    console.log('Please type a number from 0.01 through 10000.');
  }
}
