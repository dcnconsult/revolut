#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  OperatorConsoleClient,
  confirmationPhrase,
  eligibleAccountPairs,
  formatMoney,
  transferAmount
} from './console-core.mjs';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('The operator console requires an interactive terminal.');
  process.exit(2);
}

const client = new OperatorConsoleClient();

async function ask(prompt) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}

async function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;
    const output = process.stdout;
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = data => {
      for (const character of String(data)) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          output.write('*');
        }
      }
    };
    output.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

function printRecord(record) {
  const amount = transferAmount(record);
  const reference = record.id ?? record.transferRef ?? '(redacted)';
  console.log(
    `${String(reference).slice(0, 12).padEnd(12)}  ` +
    `${formatMoney(amount.amountMinor, amount.currency).padEnd(12)}  ` +
    `${record.state.padEnd(10)}  ${record.updatedAt}`
  );
}

async function showStatus() {
  const [status, summary] = await Promise.all([client.status(), client.summary()]);
  heading('Sandbox status');
  console.log(`Environment:       ${status.mode.toUpperCase()} - NO LIVE DATA`);
  console.log(`Access:            ${status.role}`);
  console.log(`Active release:    ${status.release}`);
  console.log(`Transfer ceiling:  ${status.maximumAmountMinor} minor units`);
  console.log(`Stored tests:      ${summary.total}`);
  console.log(`Backup:            ${status.backup?.state ?? 'unavailable'}${status.backup?.latestAt ? ` (${status.backup.latestAt})` : ''}`);
}

async function showTransfers() {
  heading('Recent Sandbox transfers');
  const records = await client.transfers(25);
  if (records.length === 0) return console.log('No transfer records.');
  console.log('REFERENCE     AMOUNT        STATE       UPDATED');
  records.forEach(printRecord);
}

async function showTransferEvents() {
  heading('Transfer audit');
  const events = await client.transferEvents(25);
  if (events.length === 0) return console.log('No transfer audit events.');
  for (const event of events) {
    console.log(`${event.createdAt}  ${event.eventType.padEnd(12)} ${event.state.padEnd(10)} ${event.transferRef ?? String(event.transferId ?? '').slice(0, 12)}`);
  }
}

async function showOperatorEvents() {
  heading('Operator audit');
  const events = await client.operatorEvents(25);
  if (events.length === 0) return console.log('No operator audit events.');
  for (const event of events) {
    console.log(`${event.createdAt}  ${event.action.padEnd(24)} ${event.outcome.padEnd(16)} ${event.actor ?? ''}`);
  }
}

async function showAccounts() {
  heading('Owned Sandbox accounts');
  const accounts = await client.accounts();
  accounts.forEach((account, index) => {
    console.log(
      `${index + 1}. ${account.name} | ${account.currency} | ` +
      `${formatMoney(account.balanceMinor, account.currency)} | ${account.state} | ${account.id}`
    );
  });
  return accounts;
}

async function prepareTransfer() {
  const accounts = await client.accounts();
  const pairs = eligibleAccountPairs(accounts);
  heading('Prepare Sandbox transfer - no funds move at this step');
  if (pairs.length === 0) return console.log('No eligible same-currency account pairs are available.');
  pairs.forEach((pair, index) => {
    console.log(`${index + 1}. ${pair.source.name} -> ${pair.target.name} (${pair.currency})`);
  });
  const pairIndex = Number(await ask('Choose pair number: ')) - 1;
  const pair = pairs[pairIndex];
  if (!pair) throw new Error('Invalid account-pair selection.');
  const status = await client.status();
  const amount = Number(await ask(`Amount (0.01 to ${(status.maximumAmountMinor / 100).toFixed(2)}): `));
  const amountMinor = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amountMinor < 1 || amountMinor > status.maximumAmountMinor) {
    throw new Error('Amount is outside the configured Sandbox range.');
  }
  const record = await client.prepareTransfer({
    sourceAccountId: pair.source.id,
    targetAccountId: pair.target.id,
    amountMinor,
    currency: pair.currency,
    reference: 'SANDBOX TEXT CONSOLE TEST',
    clientReference: randomUUID()
  });
  console.log(`Prepared ${record.id}: ${formatMoney(amountMinor, pair.currency)}. No funds have moved.`);
}

async function chooseTransfer(states, prompt) {
  const records = (await client.transfers(100)).filter(record =>
    record.id && states.includes(record.state)
  );
  if (records.length === 0) {
    console.log(`No transfers in state: ${states.join(', ')}.`);
    return undefined;
  }
  records.forEach((record, index) => {
    const amount = transferAmount(record);
    console.log(`${index + 1}. ${record.id} | ${formatMoney(amount.amountMinor, amount.currency)} | ${record.state}`);
  });
  const selection = Number(await ask(prompt)) - 1;
  if (!records[selection]) throw new Error('Invalid transfer selection.');
  return records[selection];
}

async function submitTransfer() {
  heading('Submit Sandbox transfer');
  const record = await chooseTransfer(['prepared'], 'Choose prepared transfer number: ');
  if (!record) return;
  const phrase = confirmationPhrase(record);
  console.log('\nFINAL SANDBOX CONFIRMATION');
  console.log('This action moves test funds in Revolut Sandbox.');
  printRecord(record);
  console.log(`Required phrase: ${phrase}`);
  const password = await readSecret('Re-enter admin password: ');
  const confirmation = await ask('Type the exact phrase: ');
  const result = await client.submitTransfer(record.id, password, confirmation);
  console.log(`Submitted once. Current Sandbox state: ${result.state}.`);
}

async function reconcileTransfer() {
  heading('Refresh Sandbox transfer status');
  const record = await chooseTransfer(['submitted', 'pending'], 'Choose transfer number: ');
  if (!record) return;
  const result = await client.reconcileTransfer(record.id);
  console.log(`Current Sandbox state: ${result.state}.`);
}

function menu(role) {
  console.log('\n1. Status and backup');
  console.log('2. Recent transfers');
  console.log('3. Transfer audit');
  console.log('4. Operator audit');
  if (role === 'admin') {
    console.log('5. List owned Sandbox accounts');
    console.log('6. Prepare Sandbox transfer');
    console.log('7. Submit prepared Sandbox transfer');
    console.log('8. Refresh submitted transfer status');
  }
  console.log('0. Sign out and exit');
}

async function run() {
  console.log('REVOLUT SANDBOX TEXT CONSOLE - NO LIVE DATA');
  const username = await ask('Username: ');
  const password = await readSecret('Password: ');
  const session = await client.login(username, password);
  console.log(`Signed in as ${session.username} (${session.role}).`);
  await showStatus();

  for (;;) {
    menu(session.role);
    const choice = await ask('Choose an action: ');
    try {
      if (choice === '0') break;
      if (choice === '1') await showStatus();
      else if (choice === '2') await showTransfers();
      else if (choice === '3') await showTransferEvents();
      else if (choice === '4') await showOperatorEvents();
      else if (choice === '5' && session.role === 'admin') await showAccounts();
      else if (choice === '6' && session.role === 'admin') await prepareTransfer();
      else if (choice === '7' && session.role === 'admin') await submitTransfer();
      else if (choice === '8' && session.role === 'admin') await reconcileTransfer();
      else console.log('That action is not available for this account.');
    } catch (error) {
      console.error(`Action failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
      if (error?.status === 401) break;
    }
  }
  await client.logout();
  console.log('Signed out.');
}

run().catch(async error => {
  console.error(`Console stopped: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  await client.logout().catch(() => undefined);
  process.exitCode = 1;
});
