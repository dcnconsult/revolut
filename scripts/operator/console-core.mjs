export const LOOPBACK_API = 'http://127.0.0.1:3000';

export class OperatorConsoleClient {
  constructor(fetchImplementation = fetch, baseUrl = LOOPBACK_API) {
    this.fetchImplementation = fetchImplementation;
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.session = undefined;
  }

  async login(username, password) {
    const response = await this.request('/v1/operator/session', {
      method: 'POST',
      body: { username, password },
      authenticate: false
    });
    this.session = response.body;
    this.cookie = response.setCookie?.split(';')[0] ?? '';
    if (!this.cookie || !this.session?.csrfToken) {
      throw new Error('The operator session response was incomplete.');
    }
    return this.session;
  }

  async logout() {
    if (!this.session) return;
    try {
      await this.request('/v1/operator/session', { method: 'DELETE' });
    } finally {
      this.session = undefined;
      this.cookie = '';
    }
  }

  status() {
    return this.get('/v1/sandbox/operator-status');
  }

  summary() {
    return this.get('/v1/sandbox/monitoring/summary');
  }

  transfers(limit = 25) {
    return this.get(`/v1/sandbox/monitoring/transfers?limit=${limit}`);
  }

  transferEvents(limit = 25) {
    return this.get(`/v1/sandbox/monitoring/audit-events?limit=${limit}`);
  }

  operatorEvents(limit = 25) {
    return this.get(`/v1/sandbox/monitoring/operator-events?limit=${limit}`);
  }

  accounts() {
    return this.get('/v1/sandbox/accounts');
  }

  prepareTransfer(request) {
    return this.mutate('/v1/sandbox/internal-transfers/prepare', request);
  }

  submitTransfer(id, password, confirmation) {
    return this.mutate(
      `/v1/sandbox/internal-transfers/${encodeURIComponent(id)}/submit`,
      { password, confirmation }
    );
  }

  reconcileTransfer(id) {
    return this.mutate(`/v1/sandbox/internal-transfers/${encodeURIComponent(id)}/reconcile`, {});
  }

  async get(path) {
    return (await this.request(path)).body;
  }

  async mutate(path, body) {
    return (await this.request(path, { method: 'POST', body })).body;
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = new Headers();
    if (options.authenticate !== false && this.cookie) headers.set('cookie', this.cookie);
    if (method !== 'GET') {
      headers.set('origin', this.baseUrl);
      if (options.authenticate !== false && this.session?.csrfToken) {
        headers.set('x-csrf-token', this.session.csrfToken);
      }
    }
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const body = response.status === 204
      ? undefined
      : await response.json().catch(() => ({ error: 'The service returned an unreadable response.' }));
    if (!response.ok) {
      const error = new Error(typeof body?.error === 'string' ? body.error : `Request failed with HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return { body, setCookie: response.headers.get('set-cookie') };
  }
}

export function formatMoney(amountMinor, currency) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency
  }).format(amountMinor / 100);
}

export function transferAmount(record) {
  return {
    amountMinor: record.request?.amountMinor ?? record.amountMinor ?? 0,
    currency: record.request?.currency ?? record.currency ?? 'GBP'
  };
}

export function confirmationPhrase(record) {
  const { amountMinor, currency } = transferAmount(record);
  return `SUBMIT ${(amountMinor / 100).toFixed(2)} ${currency}`;
}

export function eligibleAccountPairs(accounts) {
  return accounts.flatMap(source => accounts
    .filter(target =>
      source.id !== target.id &&
      source.state === 'active' &&
      target.state === 'active' &&
      source.currency === target.currency
    )
    .map(target => ({ source, target, currency: source.currency })));
}
