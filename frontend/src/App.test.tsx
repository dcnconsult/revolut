// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { App } from './App';

const server = setupServer(
  http.get('/v1/operator/session', () => HttpResponse.json({
    username: 'viewer',
    role: 'viewer',
    csrfToken: 'csrf-test'
  })),
  http.get('/v1/sandbox/monitoring/summary', () => HttpResponse.json({ total: 1, byState: { prepared: 1 } })),
  http.get('/v1/sandbox/operator-status', () => HttpResponse.json({
    mode: 'sandbox', liveData: false, maximumAmountMinor: 1000, role: 'viewer', generatedAt: new Date().toISOString()
  })),
  http.get('/v1/sandbox/monitoring/transfers', () => HttpResponse.json([{
    transferRef: 'abcd1234', state: 'prepared', amountMinor: 1, currency: 'GBP',
    reference: 'Sandbox test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }])),
  http.get('/v1/sandbox/monitoring/operator-events', () => HttpResponse.json([])),
  http.get('/v1/sandbox/monitoring/error-report', () => HttpResponse.json({
    health: 'clear', unresolved: 0, critical: 0, warning: 0, retryable: 0,
    totalOccurrences: 0, byCategory: {}, generatedAt: new Date().toISOString()
  })),
  http.get('/v1/sandbox/monitoring/errors', () => HttpResponse.json([]))
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());

describe('operator console', () => {
  it('shows a redacted read-only dashboard without admin controls', async () => {
    render(<App />);
    expect(await screen.findByText('Sandbox control room')).toBeInTheDocument();
    expect(screen.getAllByText('Read only')).toHaveLength(2);
    expect(await screen.findByText('abcd1234')).toBeInTheDocument();
    expect(screen.queryByText('Run a controlled Sandbox transfer')).not.toBeInTheDocument();
    expect(screen.getByText(/NO LIVE DATA/)).toBeInTheDocument();
    expect(await screen.findByText('Consolidated operational report')).toBeInTheDocument();
    expect(screen.getByText('No operational errors have been recorded.')).toBeInTheDocument();
  });

  it('shows the sign-in form when no session exists', async () => {
    server.use(http.get('/v1/operator/session', () => HttpResponse.json(
      { error: 'Authentication required.' },
      { status: 401 }
    )));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Sandbox operator sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
