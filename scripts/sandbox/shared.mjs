import { spawn, spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SECRET_DIR = join(PROJECT_ROOT, '.secrets', 'sandbox');
export const PRIVATE_KEY_FILE = join(SECRET_DIR, 'privatecert.pem');
export const PUBLIC_CERT_FILE = join(SECRET_DIR, 'publiccert.cer');
export const CONFIG_FILE = join(SECRET_DIR, 'config.json');
export const TOKEN_FILE = join(SECRET_DIR, 'tokens.json');

export const SANDBOX_WEB_URL = 'https://sandbox-business.revolut.com';
export const SANDBOX_SETTINGS_URL = `${SANDBOX_WEB_URL}/settings/apis?tab=business-api`;
export const SANDBOX_API_BASE_URL = 'https://sandbox-b2b.revolut.com/api/1.0';
export const SANDBOX_WEBHOOK_BASE_URL = 'https://sandbox-b2b.revolut.com/api/2.0';
export const TOKEN_URL = `${SANDBOX_API_BASE_URL}/auth/token`;
export const DEFAULT_REDIRECT_URI = 'https://example.com';
export const DEFAULT_CERTIFICATE_TITLE = 'REVOLUTE Sandbox';
export const CLIENT_ASSERTION_AUDIENCE = 'https://revolut.com';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REFRESH_MARGIN_MS = 60_000;

export class SandboxSetupError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SandboxSetupError';
    this.details = details;
  }
}

export async function ensureSecretDirectory() {
  await mkdir(SECRET_DIR, { recursive: true, mode: 0o700 });
  await bestEffortChmod(SECRET_DIR, 0o700);
}

export async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new SandboxSetupError(`Could not read ${path}.`, safeErrorMessage(error));
  }
}

export async function writePrivateJson(path, value) {
  await ensureSecretDirectory();
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await bestEffortChmod(tempPath, 0o600);
  try {
    await rename(tempPath, path);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await deleteFileIfPresent(path);
    await rename(tempPath, path);
  }
  await bestEffortChmod(path, 0o600);
}

export async function deleteFileIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function validateClientId(value) {
  const clientId = String(value ?? '').trim();
  if (!clientId) throw new SandboxSetupError('ClientID cannot be blank.');
  if (clientId.length > 300 || /\s/.test(clientId)) {
    throw new SandboxSetupError('ClientID should be copied exactly and must not contain spaces.');
  }
  return clientId;
}

export function issuerFromRedirectUri(value) {
  let redirect;
  try {
    redirect = new URL(String(value).trim());
  } catch {
    throw new SandboxSetupError('OAuth redirect URI is not a valid URL.');
  }
  if (redirect.protocol !== 'https:') {
    throw new SandboxSetupError('Use an HTTPS OAuth redirect URI for this guided setup.');
  }
  if (!redirect.hostname) throw new SandboxSetupError('OAuth redirect URI must contain a domain.');
  return redirect.host;
}

export function extractAuthorizationCode(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new SandboxSetupError('The authorization URL or code cannot be blank.');

  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new SandboxSetupError('The pasted browser address is not a valid URL.');
    }
    const code = url.searchParams.get('code');
    if (!code) throw new SandboxSetupError('The pasted URL does not contain a code= value.');
    return code;
  }

  if (/\s/.test(text)) throw new SandboxSetupError('The authorization code must not contain spaces.');
  return text;
}

export async function generateOrReuseCertificate() {
  await ensureSecretDirectory();
  const [privateExists, publicExists] = await Promise.all([
    fileExists(PRIVATE_KEY_FILE),
    fileExists(PUBLIC_CERT_FILE)
  ]);

  if (privateExists !== publicExists) {
    throw new SandboxSetupError(
      'Only one certificate file exists. Do not generate over it. Restore the matching file or remove both Sandbox certificate files after confirming they are not registered in Revolut.'
    );
  }

  const openssl = findOpenSsl();
  if (!openssl) {
    throw new SandboxSetupError(
      'OpenSSL was not found. On Windows, install or repair Git for Windows, then reopen PowerShell and run the command again.'
    );
  }

  if (!privateExists) {
    runCommand(openssl, ['genrsa', '-out', PRIVATE_KEY_FILE, '2048'], 'Could not generate the private key.');
    runCommand(
      openssl,
      [
        'req', '-new', '-x509',
        '-key', PRIVATE_KEY_FILE,
        '-out', PUBLIC_CERT_FILE,
        '-days', '1825',
        '-subj', '/CN=REVOLUTE Sandbox'
      ],
      'Could not generate the public certificate.'
    );
    await bestEffortChmod(PRIVATE_KEY_FILE, 0o600);
    await bestEffortChmod(PUBLIC_CERT_FILE, 0o644);
  }

  verifyCertificatePair(openssl);
  return {
    created: !privateExists,
    openssl,
    publicCertificate: await readFile(PUBLIC_CERT_FILE, 'utf8')
  };
}

export function findOpenSsl() {
  const candidates = [];
  if (process.env.OPENSSL_PATH) candidates.push(process.env.OPENSSL_PATH);
  candidates.push('openssl');

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const localAppData = process.env.LOCALAPPDATA;
    candidates.push(
      join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
      join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe')
    );
    if (programFilesX86) {
      candidates.push(join(programFilesX86, 'Git', 'usr', 'bin', 'openssl.exe'));
    }
    if (localAppData) {
      candidates.push(
        join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
        join(localAppData, 'Programs', 'Git', 'mingw64', 'bin', 'openssl.exe')
      );
    }
  }

  for (const candidate of candidates) {
    if (candidate !== 'openssl' && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

export async function createClientAssertion(config) {
  const privatePem = await readFile(PRIVATE_KEY_FILE, 'utf8');
  const privateKey = createPrivateKey(privatePem);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.issuer)
    .setSubject(config.clientId)
    .setAudience(CLIENT_ASSERTION_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 10 * 60)
    .sign(privateKey);
}

export async function saveSandboxConfig({ clientId, redirectUri = DEFAULT_REDIRECT_URI }) {
  const normalizedClientId = validateClientId(clientId);
  const issuer = issuerFromRedirectUri(redirectUri);
  const config = {
    environment: 'sandbox',
    clientId: normalizedClientId,
    redirectUri,
    issuer,
    certificateTitle: DEFAULT_CERTIFICATE_TITLE,
    apiBaseUrl: SANDBOX_API_BASE_URL,
    webhookBaseUrl: SANDBOX_WEBHOOK_BASE_URL,
    savedAt: new Date().toISOString()
  };
  await writePrivateJson(CONFIG_FILE, config);
  return config;
}

export async function loadSandboxConfig() {
  const config = await readJson(CONFIG_FILE);
  if (!config) {
    throw new SandboxSetupError('Sandbox setup has not been completed. Run: npm run sandbox:setup');
  }
  if (config.environment !== 'sandbox' || config.apiBaseUrl !== SANDBOX_API_BASE_URL) {
    throw new SandboxSetupError('The saved configuration is not a Sandbox-only configuration.');
  }
  validateClientId(config.clientId);
  const expectedIssuer = issuerFromRedirectUri(config.redirectUri);
  if (config.issuer !== expectedIssuer) {
    throw new SandboxSetupError('The saved issuer does not match the OAuth redirect URI domain.');
  }
  return config;
}

export async function exchangeAuthorizationCode(code, config) {
  const clientAssertion = await createClientAssertion(config);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion
  });
  const tokenResponse = await tokenRequest(body);
  if (!tokenResponse.refresh_token) {
    throw new SandboxSetupError('Revolut did not return a refresh token. The authorization flow must be repeated.');
  }
  const tokens = normalizeTokenResponse(tokenResponse);
  await writePrivateJson(TOKEN_FILE, tokens);
  return tokens;
}

export async function refreshAccessToken() {
  const [config, tokens] = await Promise.all([loadSandboxConfig(), readJson(TOKEN_FILE)]);
  if (!tokens?.refreshToken) {
    throw new SandboxSetupError('No Sandbox refresh token is saved. Run: npm run sandbox:setup');
  }

  const clientAssertion = await createClientAssertion(config);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion
  });
  const tokenResponse = await tokenRequest(body);
  const updated = normalizeTokenResponse(tokenResponse, tokens.refreshToken);
  await writePrivateJson(TOKEN_FILE, updated);
  return updated;
}

export async function getUsableAccessToken() {
  const tokens = await readJson(TOKEN_FILE);
  if (!tokens?.accessToken) {
    throw new SandboxSetupError('No Sandbox access token is saved. Run: npm run sandbox:setup');
  }
  const expiresAt = Date.parse(tokens.accessTokenExpiresAt ?? '');
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return tokens.accessToken;
  }
  const refreshed = await refreshAccessToken();
  return refreshed.accessToken;
}

export async function sandboxApiRequest(path, { method = 'GET', body, scopesDescription } = {}) {
  if (!path.startsWith('/')) throw new SandboxSetupError('Sandbox API path must start with /.');
  const url = `${SANDBOX_API_BASE_URL}${path}`;
  let token = await getUsableAccessToken();
  const headers = {};
  let requestBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  let response = await fetch(url, {
    method,
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body: requestBody
  });
  let text = await response.text();
  if (response.status === 401) {
    token = (await refreshAccessToken()).accessToken;
    response = await fetch(url, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body: requestBody
    });
    text = await response.text();
  }

  const parsed = parseJsonMaybe(text);
  if (!response.ok) {
    const explanation = formatApiError(response.status, parsed, text);
    const scopeHint = scopesDescription ? ` Required consent scope(s): ${scopesDescription}.` : '';
    throw new SandboxSetupError(`Sandbox API request failed.${scopeHint}`, explanation);
  }
  return parsed ?? text;
}

export async function getAccounts() {
  const accounts = await sandboxApiRequest('/accounts', { scopesDescription: 'READ' });
  if (!Array.isArray(accounts)) {
    throw new SandboxSetupError('The /accounts response was not a list.');
  }
  return accounts;
}

export function printAccounts(accounts) {
  if (accounts.length === 0) {
    console.log('\nThe request succeeded, but no accounts were returned.');
    return;
  }
  const rows = accounts.map((account, index) => ({
    '#': index + 1,
    Name: account.name ?? '(unnamed)',
    Currency: account.currency ?? '',
    Balance: account.balance ?? '',
    State: account.state ?? '',
    ID: account.id ?? ''
  }));
  console.table(rows);
}

export function copyToClipboard(text) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('clip.exe', [], { input: text, encoding: 'utf8', windowsHide: true });
      return result.status === 0;
    }
    if (process.platform === 'darwin') {
      return spawnSync('pbcopy', [], { input: text, encoding: 'utf8' }).status === 0;
    }
    if (spawnSync('wl-copy', [], { input: text, encoding: 'utf8' }).status === 0) return true;
    return spawnSync('xclip', ['-selection', 'clipboard'], { input: text, encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

export function openBrowser(url) {
  try {
    let command;
    let args;
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/d', '/s', '/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      command = 'open';
      args = [url];
    } else {
      command = 'xdg-open';
      args = [url];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function formatFailure(error) {
  if (error instanceof SandboxSetupError) {
    return error.details ? `${error.message}\nDetails: ${error.details}` : error.message;
  }
  return safeErrorMessage(error);
}

export function maskClientId(clientId) {
  if (!clientId || clientId.length < 10) return '(saved ClientID)';
  return `${clientId.slice(0, 5)}…${clientId.slice(-5)}`;
}

function runCommand(command, args, failureMessage) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new SandboxSetupError(failureMessage, (result.stderr || result.stdout || '').trim());
  }
  return result.stdout;
}

function verifyCertificatePair(openssl) {
  const privatePublic = runCommand(
    openssl,
    ['pkey', '-in', PRIVATE_KEY_FILE, '-pubout'],
    'Could not read the Sandbox private key.'
  ).replace(/\s+/g, '');
  const certificatePublic = runCommand(
    openssl,
    ['x509', '-in', PUBLIC_CERT_FILE, '-pubkey', '-noout'],
    'Could not read the Sandbox public certificate.'
  ).replace(/\s+/g, '');
  if (privatePublic !== certificatePublic) {
    throw new SandboxSetupError('The Sandbox private key and public certificate do not match.');
  }
}

async function tokenRequest(body) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch (error) {
    throw new SandboxSetupError('Could not reach the Revolut Sandbox token endpoint.', safeErrorMessage(error));
  }

  const text = await response.text();
  const parsed = parseJsonMaybe(text);
  if (!response.ok) {
    throw new SandboxSetupError('Revolut rejected the authorization request.', formatApiError(response.status, parsed, text));
  }
  if (!parsed?.access_token || !parsed?.expires_in) {
    throw new SandboxSetupError('The token response did not contain the expected access token fields.');
  }
  return parsed;
}

function normalizeTokenResponse(response, existingRefreshToken) {
  const expiresInSeconds = Number(response.expires_in);
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new SandboxSetupError('The access-token expiry value was invalid.');
  }
  return {
    environment: 'sandbox',
    tokenType: response.token_type ?? 'bearer',
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? existingRefreshToken,
    accessTokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function parseJsonMaybe(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function formatApiError(status, parsed, rawText) {
  const code = parsed?.code ?? parsed?.error;
  const message = parsed?.message ?? parsed?.error_description ?? rawText?.slice(0, 500) ?? 'No response body.';
  return [`HTTP ${status}`, code ? `code=${code}` : undefined, message].filter(Boolean).join(' — ');
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function bestEffortChmod(path, mode) {
  if (process.platform === 'win32') return;
  try {
    await chmod(path, mode);
  } catch {
    // File permissions are best-effort on non-POSIX filesystems.
  }
}
