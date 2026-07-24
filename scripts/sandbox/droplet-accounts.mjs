import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';

export const SANDBOX_API_BASE_URL = 'https://sandbox-b2b.revolut.com/api/1.0';
const CLIENT_ASSERTION_AUDIENCE = 'https://revolut.com';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export function loadDropletSandboxConfig(environment = process.env) {
  const baseUrl = required(environment, 'REVOLUT_SANDBOX_BASE_URL');
  if (baseUrl !== SANDBOX_API_BASE_URL) {
    throw new Error(`Refusing non-Sandbox API URL: ${baseUrl}`);
  }

  return {
    baseUrl,
    clientId: required(environment, 'REVOLUT_SANDBOX_CLIENT_ID'),
    issuer: required(environment, 'REVOLUT_SANDBOX_ISSUER'),
    privateKeyPath: required(environment, 'REVOLUT_SANDBOX_PRIVATE_KEY_PATH'),
    refreshToken: required(environment, 'REVOLUT_SANDBOX_REFRESH_TOKEN')
  };
}

export async function loadDropletSandboxConfigFiles({
  configPath,
  tokensPath,
  privateKeyPath
}) {
  const [savedConfig, savedTokens] = await Promise.all([
    readJsonFile(configPath, 'Sandbox configuration'),
    readJsonFile(tokensPath, 'Sandbox tokens')
  ]);
  if (savedConfig.environment !== 'sandbox' || savedTokens.environment !== 'sandbox') {
    throw new Error('Refusing credentials that are not marked for Sandbox.');
  }

  return loadDropletSandboxConfig({
    REVOLUT_SANDBOX_BASE_URL: savedConfig.apiBaseUrl,
    REVOLUT_SANDBOX_CLIENT_ID: savedConfig.clientId,
    REVOLUT_SANDBOX_ISSUER: savedConfig.issuer,
    REVOLUT_SANDBOX_PRIVATE_KEY_PATH: privateKeyPath,
    REVOLUT_SANDBOX_REFRESH_TOKEN: savedTokens.refreshToken
  });
}

export async function runDropletAccountsProbe(config, fetchImplementation = fetch) {
  const privatePem = await readFile(config.privateKeyPath, 'utf8');
  const privateKey = createPrivateKey(privatePem);
  const now = Math.floor(Date.now() / 1000);
  const clientAssertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.issuer)
    .setSubject(config.clientId)
    .setAudience(CLIENT_ASSERTION_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 10 * 60)
    .sign(privateKey);

  const tokenResponse = await fetchImplementation(`${config.baseUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: clientAssertion
    })
  });
  const tokenPayload = await readJsonResponse(tokenResponse, 'token refresh');
  if (!tokenResponse.ok || !tokenPayload?.access_token) {
    throw new Error(formatRevolutError(tokenResponse.status, tokenPayload, 'Sandbox token refresh failed'));
  }

  const accountsResponse = await fetchImplementation(`${config.baseUrl}/accounts`, {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
  });
  const accounts = await readJsonResponse(accountsResponse, 'GET /accounts');
  if (!accountsResponse.ok || !Array.isArray(accounts)) {
    throw new Error(formatRevolutError(accountsResponse.status, accounts, 'Sandbox GET /accounts failed'));
  }

  return summarizeAccounts(accounts);
}

export function summarizeAccounts(accounts) {
  const currencies = [...new Set(accounts.map(account => account.currency).filter(Boolean))].sort();
  return {
    accountCount: accounts.length,
    activeAccountCount: accounts.filter(account => account.state === 'active').length,
    currencies
  };
}

function required(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`Missing required Sandbox setting: ${name}`);
  return value;
}

async function readJsonResponse(response, operation) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Revolut ${operation} returned a non-JSON response (HTTP ${response.status}).`);
  }
}

async function readJsonFile(path, description) {
  if (!path) throw new Error(`Missing ${description} file path.`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatRevolutError(status, payload, fallback) {
  const detail = payload?.error_description ?? payload?.message ?? payload?.error ?? fallback;
  return `${fallback} (HTTP ${status}): ${detail}`;
}

async function main() {
  const config = process.env.REVOLUT_SANDBOX_CONFIG_PATH
    ? await loadDropletSandboxConfigFiles({
      configPath: process.env.REVOLUT_SANDBOX_CONFIG_PATH,
      tokensPath: process.env.REVOLUT_SANDBOX_TOKENS_PATH,
      privateKeyPath: process.env.REVOLUT_SANDBOX_PRIVATE_KEY_PATH
    })
    : loadDropletSandboxConfig();
  const summary = await runDropletAccountsProbe(config);
  console.log([
    'PHASE2_SANDBOX_OK',
    `accounts=${summary.accountCount}`,
    `active=${summary.activeAccountCount}`,
    `currencies=${summary.currencies.join(',') || 'none'}`,
    'host=sandbox-b2b.revolut.com',
    'permission=READ'
  ].join(' '));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(`PHASE2_SANDBOX_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
