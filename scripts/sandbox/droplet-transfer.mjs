import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildAccountTransferPayload,
  findEligibleAccountPairs,
  parseSandboxTransferAmount,
  sanitizeTransferResult
} from './account-transfer-core.mjs';
import {
  createDropletAccessToken,
  dropletSandboxApiRequest,
  loadDropletSandboxConfig,
  loadDropletSandboxConfigFiles
} from './droplet-accounts.mjs';

export async function runDropletTransferTest(config, {
  amount = 0.01,
  execute = false,
  requestId = randomUUID(),
  accessToken,
  fetchImplementation = fetch
} = {}) {
  const normalizedAmount = parseSandboxTransferAmount(amount);
  const token = accessToken ?? await createDropletAccessToken(config, fetchImplementation);
  const accounts = await dropletSandboxApiRequest(config, '/accounts', {
    accessToken: token,
    fetchImplementation
  });
  if (!Array.isArray(accounts)) throw new Error('Sandbox GET /accounts did not return a list.');

  const pair = findEligibleAccountPairs(accounts, normalizedAmount)[0];
  if (!pair) {
    throw new Error(
      `No eligible same-currency Sandbox account pair can transfer ${normalizedAmount.toFixed(2)}.`
    );
  }
  const payload = buildAccountTransferPayload({
    source: pair.source,
    target: pair.target,
    amount: normalizedAmount,
    requestId
  });

  if (!execute) return sanitizeTransferResult(undefined, payload, false);
  const result = await dropletSandboxApiRequest(config, '/transfer', {
    method: 'POST',
    body: payload,
    accessToken: token,
    fetchImplementation
  });
  return sanitizeTransferResult(result, payload, true);
}

function printResult(summary) {
  console.log([
    summary.execution === 'EXECUTED' ? 'PHASE3_SANDBOX_TRANSFER_OK' : 'PHASE3_SANDBOX_TRANSFER_READY',
    `execution=${summary.execution}`,
    `state=${summary.state}`,
    `amount=${summary.amount.toFixed(2)}`,
    `currency=${summary.currency}`,
    `host=${summary.host}`,
    `permission=${summary.permission}`,
    `live_data=${summary.liveData}`
  ].join(' '));
}

async function main() {
  const config = process.env.REVOLUT_SANDBOX_CONFIG_PATH
    ? await loadDropletSandboxConfigFiles({
      configPath: process.env.REVOLUT_SANDBOX_CONFIG_PATH,
      tokensPath: process.env.REVOLUT_SANDBOX_TOKENS_PATH,
      privateKeyPath: process.env.REVOLUT_SANDBOX_PRIVATE_KEY_PATH
    })
    : loadDropletSandboxConfig();
  const execute = process.env.SANDBOX_TRANSFER_EXECUTE === 'YES';
  const summary = await runDropletTransferTest(config, {
    amount: process.env.SANDBOX_TRANSFER_AMOUNT ?? 0.01,
    execute
  });
  printResult(summary);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(`PHASE3_SANDBOX_TRANSFER_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
