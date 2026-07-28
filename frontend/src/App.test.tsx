// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  http.get('/v1/sandbox/monitoring/errors', () => HttpResponse.json([])),
  http.get('/v1/cases', () => HttpResponse.json([]))
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
    expect(screen.getByText('Funding case inbox')).toBeInTheDocument();
    expect(screen.getByText('Match incoming credit')).toBeInTheDocument();
    expect(screen.getByText('No operational errors have been recorded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open operator guide in a new window' }))
      .toHaveAttribute('href', '/operator/help/index.html');
    expect(screen.getByRole('link', { name: 'Open operator guide in a new window' }))
      .toHaveAttribute('target', '_blank');
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
    expect(screen.getByRole('link', { name: 'Open operator guide in a new window' }))
      .toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens an intake-held case in the administrator Sandbox walkthrough', async () => {
    const caseId = '3f9b0521-33d0-46a9-835a-16ba77f0d564';
    server.use(
      http.get('/v1/operator/session', () => HttpResponse.json({
        username: 'admin',
        role: 'admin',
        csrfToken: 'csrf-admin'
      })),
      http.get('/v1/cases', () => HttpResponse.json([{
        id: caseId,
        caseStatus: 'INTAKE_HOLD',
        fundingStatus: 'AWAITING_FUNDS',
        executionStatus: 'NOT_PLANNED',
        overallRisk: 'HIGH',
        hardBlockCount: 1,
        updatedAt: new Date().toISOString(),
        nextAction: 'Provide a new package.'
      }])),
      http.get(`/v1/cases/${caseId}`, () => HttpResponse.json({
        id: caseId,
        caseStatus: 'INTAKE_HOLD',
        fundingStatus: 'AWAITING_FUNDS',
        executionStatus: 'NOT_PLANNED',
        riskFindings: [{
          code: 'PACKAGE_VALIDATION_FAILED',
          hardBlock: true,
          message: 'Submission is not a ZIP archive.',
          neededNext: 'Provide a new package.'
        }],
        providerObservations: [],
        plans: []
      })),
      http.get('/v1/sandbox/accounts', () => HttpResponse.json([
        { id: 'source', name: 'USD source', currency: 'USD', balanceMinor: 1000, state: 'active' },
        { id: 'target', name: 'USD target', currency: 'USD', balanceMinor: 0, state: 'active' }
      ]))
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    expect(await screen.findByRole('heading', { name: 'Prepare synthetic Sandbox case inputs' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare walkthrough' })).toBeEnabled();
    expect(screen.getByText(/never treats the uploaded package as cleared evidence/i)).toBeInTheDocument();
  });

  it('clears reauthentication secrets before the execution confirmation', async () => {
    const caseId = '6cfa5885-7d9a-42da-91e1-409ca16a4a28';
    let executionStatus = 'AWAITING_AUTHORIZATION';
    let planStatus = 'AWAITING_AUTHORIZATION';
    const record = () => ({
      id: caseId,
      caseStatus: 'APPROVED',
      fundingStatus: 'MATCHED',
      executionStatus,
      riskFindings: [],
      fundingExpectation: {
        destinationAccountId: 'source',
        amountMinor: 1000,
        currency: 'USD',
        exponent: 2,
        reference: 'SANDBOX CASE 6CFA5885'
      },
      providerObservations: [],
      plans: [{ version: 1, status: planStatus, digest: 'abcdef1234567890' }]
    });
    server.use(
      http.get('/v1/operator/session', () => HttpResponse.json({
        username: 'admin',
        role: 'admin',
        csrfToken: 'csrf-admin'
      })),
      http.get('/v1/cases', () => HttpResponse.json([{
        id: caseId,
        caseStatus: 'APPROVED',
        fundingStatus: 'MATCHED',
        executionStatus,
        overallRisk: 'LOW',
        hardBlockCount: 0,
        updatedAt: new Date().toISOString(),
        nextAction: 'Authorize the exact funding-plan digest.'
      }])),
      http.get(`/v1/cases/${caseId}`, () => HttpResponse.json(record())),
      http.get('/v1/sandbox/accounts', () => HttpResponse.json([
        { id: 'source', name: 'USD source', currency: 'USD', balanceMinor: 1000, state: 'active' },
        { id: 'target', name: 'USD target', currency: 'USD', balanceMinor: 0, state: 'active' }
      ])),
      http.post(`/v1/cases/${caseId}/plans/1/authorize`, () => {
        executionStatus = 'AUTHORIZED';
        planStatus = 'AUTHORIZED';
        return HttpResponse.json(record());
      })
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    expect(await screen.findByRole('heading', { name: 'Authorize the exact Sandbox plan' }))
      .toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Administrator password'), {
      target: { value: 'admin-test-password' }
    });
    fireEvent.change(screen.getByLabelText('Fresh authenticator code'), {
      target: { value: '000000' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize plan' }));
    expect(await screen.findByRole('heading', { name: 'Execute the authorized Sandbox transfer' }))
      .toBeInTheDocument();
    expect(screen.getByLabelText('Administrator password')).toHaveValue('');
    expect(screen.getByLabelText('Fresh authenticator code')).toHaveValue('');
  });
});
