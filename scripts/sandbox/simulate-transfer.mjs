import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { formatFailure, sandboxApiRequest } from './shared.mjs';

const rl = createInterface({ input, output });
const actions = ['complete', 'revert', 'decline', 'fail'];

try {
  console.log('REVOLUTE — Sandbox transfer-state simulator');
  console.log('Use this only with a transfer ID created in Revolut Sandbox.');
  const id = await chooseTransactionId();
  const action = await chooseAction();

  console.log(`\nThis will set Sandbox transfer ${id} to the final ${action} outcome.`);
  console.log('The resulting state is final and cannot be changed.');
  const confirmation = (await rl.question('Type FINAL to continue: ')).trim();
  if (confirmation !== 'FINAL') throw new Error('Simulation cancelled.');

  const result = await sandboxApiRequest(`/sandbox/transactions/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    scopesDescription: 'WRITE'
  });

  console.log('\nSandbox simulation response:');
  console.table([{
    Transaction: result.id ?? '',
    State: result.state ?? '',
    Created: result.created_at ?? '',
    Completed: result.completed_at ?? ''
  }]);
  console.log('\nSUCCESS: the transfer state was changed in Sandbox only.');
} catch (error) {
  console.error(`\nSIMULATION STOPPED\n${formatFailure(error)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

async function chooseTransactionId() {
  while (true) {
    const value = (await rl.question('Paste the Sandbox transfer ID: ')).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
    console.log('That does not look like a UUID transfer ID. Copy the id field exactly.');
  }
}

async function chooseAction() {
  console.log('\nChoose the test outcome:');
  actions.forEach((action, index) => console.log(`  ${index + 1}. ${action}`));
  while (true) {
    const answer = Number((await rl.question('Type 1, 2, 3, or 4: ')).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= actions.length) return actions[answer - 1];
    console.log('Please type 1, 2, 3, or 4.');
  }
}
