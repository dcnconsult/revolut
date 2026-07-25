import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SignJWT } from 'jose';
import {
  classifyHttpStatus,
  OperationalFault
} from '../operations/operational-error-monitor.js';

export const REVOLUT_SANDBOX_API_BASE_URL = 'https://sandbox-b2b.revolut.com/api/1.0';

const CLIENT_ASSERTION_AUDIENCE = 'https://revolut.com';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const REFRESH_MARGIN_MS = 60_000;
const API_TIMEOUT_MS = 8_000;
const MAX_TRANSIENT_RETRIES = 2;

export interface RevolutSandboxAccount {
  id: string;
  name?: string;
  currency: string;
  balance: number;
  state: string;
}

export interface RevolutSandboxTransfer {
  id: string;
  state: string;
  created_at?: string;
  completed_at?: string;
}

export interface SandboxInternalTransferClient {
  getAccounts(): Promise<RevolutSandboxAccount[]>;
  createInternalTransfer(input: {
    requestId: string;
    sourceAccountId: string;
    targetAccountId: string;
    amount: number;
    currency: string;
    reference: string;
  }): Promise<RevolutSandboxTransfer>;
  getTransaction(transactionId: string): Promise<RevolutSandboxTransfer>;
}

interface SandboxCredentialFiles {
  configPath: string;
  tokensPath: string;
  privateKeyPath: string;
}

interface SavedConfig {
  environment?: string;
  apiBaseUrl?: string;
  clientId?: string;
  issuer?: string;
}

interface SavedTokens {
  environment?: string;
  refreshToken?: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class RevolutSandboxClient implements SandboxInternalTransferClient {
  private cachedToken: CachedToken | undefined;
  private tokenRefreshInFlight: Promise<string> | undefined;

  constructor(
    private readonly files: SandboxCredentialFiles,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  async getAccounts() {
    const result = await this.request('/accounts');
    if (!Array.isArray(result)) throw new Error('Revolut Sandbox /accounts did not return a list.');
    return result.map(account => this.parseAccount(account));
  }

  async createInternalTransfer(input: {
    requestId: string;
    sourceAccountId: string;
    targetAccountId: string;
    amount: number;
    currency: string;
    reference: string;
  }) {
    const result = await this.request('/transfer', {
      method: 'POST',
      body: {
        request_id: input.requestId,
        source_account_id: input.sourceAccountId,
        target_account_id: input.targetAccountId,
        amount: input.amount,
        currency: input.currency,
        reference: input.reference
      }
    });
    return this.parseTransfer(result);
  }

  async getTransaction(transactionId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(transactionId)) throw new Error('Invalid Sandbox transaction ID.');
    return this.parseTransfer(await this.request(`/transaction/${encodeURIComponent(transactionId)}`));
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}) {
    if (!path.startsWith('/')) throw new Error('Sandbox API path must start with /.');
    const credentials = await this.loadCredentials();
    let accessToken = await this.getAccessToken(credentials);
    let authenticationRetried = false;
    let transientRetries = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchApi(credentials.baseUrl, path, accessToken, options);
      } catch {
        if (transientRetries < MAX_TRANSIENT_RETRIES) {
          await delay(this.retryDelay(undefined, transientRetries++));
          continue;
        }
        throw new OperationalFault(
          `Revolut Sandbox ${options.method ?? 'GET'} ${path} failed because the network was unavailable.`,
          { category: 'network', severity: 'critical', retryable: true }
        );
      }
      if (response.status === 401 && !authenticationRetried) {
        authenticationRetried = true;
        this.cachedToken = undefined;
        accessToken = await this.getAccessToken(credentials);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) &&
          transientRetries < MAX_TRANSIENT_RETRIES) {
        await delay(this.retryDelay(response, transientRetries++));
        continue;
      }
      const payload = await this.readResponse(response);
      if (!response.ok) {
        throw new OperationalFault(
          `Revolut Sandbox ${options.method ?? 'GET'} ${path} failed (HTTP ${response.status}).`,
          classifyHttpStatus(response.status)
        );
      }
      return payload;
    }
  }

  private async fetchApi(
    baseUrl: string,
    path: string,
    accessToken: string,
    options: { method?: string; body?: unknown }
  ) {
    return this.fetchImplementation(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
  }

  private async getAccessToken(credentials: Awaited<ReturnType<RevolutSandboxClient['loadCredentials']>>) {
    if (this.cachedToken && this.cachedToken.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return this.cachedToken.value;
    }
    if (this.tokenRefreshInFlight) return this.tokenRefreshInFlight;
    this.tokenRefreshInFlight = this.refreshAccessToken(credentials);
    try {
      return await this.tokenRefreshInFlight;
    } finally {
      this.tokenRefreshInFlight = undefined;
    }
  }

  private async refreshAccessToken(credentials: Awaited<ReturnType<RevolutSandboxClient['loadCredentials']>>) {
    const privateKey = createPrivateKey(await readFile(this.files.privateKeyPath, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(credentials.issuer)
      .setSubject(credentials.clientId)
      .setAudience(CLIENT_ASSERTION_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 10 * 60)
      .sign(privateKey);

    const response = await this.fetchImplementation(`${credentials.baseUrl}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: assertion
      })
    });
    const payload = await this.readResponse(response);
    const accessToken = this.stringField(payload, 'access_token');
    const expiresIn = Number(this.field(payload, 'expires_in'));
    if (!response.ok || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OperationalFault(
        `Revolut Sandbox token refresh failed (HTTP ${response.status}).`,
        response.ok
          ? { category: 'invalid_response', severity: 'critical', retryable: false }
          : classifyHttpStatus(response.status)
      );
    }
    this.cachedToken = { value: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  }

  private async loadCredentials() {
    const [config, tokens] = await Promise.all([
      this.readJsonFile<SavedConfig>(this.files.configPath, 'Sandbox configuration'),
      this.readJsonFile<SavedTokens>(this.files.tokensPath, 'Sandbox tokens')
    ]);
    if (config.environment !== 'sandbox' || tokens.environment !== 'sandbox') {
      throw new Error('Refusing credentials that are not marked for Sandbox.');
    }
    if (config.apiBaseUrl !== REVOLUT_SANDBOX_API_BASE_URL) {
      throw new Error(`Refusing non-Sandbox API URL: ${config.apiBaseUrl ?? '(missing)'}`);
    }
    const clientId = this.required(config.clientId, 'Sandbox client ID');
    const issuer = this.required(config.issuer, 'Sandbox issuer');
    const refreshToken = this.required(tokens.refreshToken, 'Sandbox refresh token');
    return { baseUrl: REVOLUT_SANDBOX_API_BASE_URL, clientId, issuer, refreshToken };
  }

  private parseAccount(value: unknown): RevolutSandboxAccount {
    const id = this.stringField(value, 'id');
    const currency = this.stringField(value, 'currency');
    const state = this.stringField(value, 'state');
    const balance = Number(this.field(value, 'balance'));
    if (!id || !currency || !state || !Number.isFinite(balance)) {
      throw new Error('Revolut Sandbox returned an invalid account.');
    }
    const name = this.stringField(value, 'name');
    return {
      id,
      currency,
      state,
      balance,
      ...(name ? { name } : {})
    };
  }

  private parseTransfer(value: unknown): RevolutSandboxTransfer {
    const id = this.stringField(value, 'id');
    const state = this.stringField(value, 'state');
    if (!id || !state) throw new Error('Revolut Sandbox returned an invalid transfer.');
    const createdAt = this.stringField(value, 'created_at');
    const completedAt = this.stringField(value, 'completed_at');
    return {
      id,
      state,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(completedAt ? { completed_at: completedAt } : {})
    };
  }

  private async readJsonFile<T>(path: string, description: string): Promise<T> {
    if (!path) throw new Error(`Missing ${description} path.`);
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      throw new Error(`Could not read ${description}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OperationalFault(
        `Revolut Sandbox returned a non-JSON response (HTTP ${response.status}).`,
        {
          category: 'invalid_response',
          severity: 'critical',
          retryable: response.status >= 500,
          httpStatus: response.status
        }
      );
    }
  }

  private retryDelay(response: Response | undefined, attempt: number) {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 0), 2_000);
      const dateDelay = Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(dateDelay)) return Math.min(Math.max(dateDelay, 0), 2_000);
    }
    return Math.min(250 * (2 ** attempt), 2_000);
  }

  private field(value: unknown, key: string) {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  }

  private stringField(value: unknown, key: string) {
    const field = this.field(value, key);
    return typeof field === 'string' ? field : '';
  }

  private required(value: unknown, description: string) {
    const normalized = String(value ?? '').trim();
    if (!normalized) throw new Error(`Missing ${description}.`);
    return normalized;
  }
}
