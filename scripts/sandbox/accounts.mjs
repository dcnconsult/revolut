import { formatFailure, getAccounts, printAccounts } from './shared.mjs';

try {
  console.log('Requesting accounts from Revolut Sandbox…');
  const accounts = await getAccounts();
  printAccounts(accounts);
  console.log('\nSUCCESS: GET /accounts returned without using a Production URL.');
} catch (error) {
  console.error(`\nACCOUNT TEST FAILED\n${formatFailure(error)}`);
  process.exitCode = 1;
}
