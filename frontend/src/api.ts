export type Role = 'admin' | 'viewer';

export interface Session {
  username: string;
  role: Role;
  csrfToken: string;
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  balanceMinor: number;
  state: string;
}

export interface Transfer {
  id?: string;
  transferRef?: string;
  state: string;
  request?: {
    sourceAccountId: string;
    targetAccountId: string;
    amountMinor: number;
    currency: string;
    reference: string;
    clientReference: string;
  };
  amountMinor?: number;
  currency?: string;
  reference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Summary {
  total: number;
  byState: Record<string, number>;
  latestUpdatedAt?: string;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
  csrfToken?: string
): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string') headers.set('content-type', 'application/json');
  if (csrfToken) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'The server returned an unexpected response.' }));
    throw new Error(typeof body.error === 'string' ? body.error : 'The request failed.');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountMinor / 100);
}
