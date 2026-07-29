// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { App, parseDecimalToMinor, sandboxWalkthroughCurrencyExponent } from './App';

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
  it('parses case walkthrough amounts exactly in minor units', () => {
    expect(parseDecimalToMinor('1000000000.00', 2)).toBe(100_000_000_000);
    expect(parseDecimalToMinor('1000000000', 0)).toBe(1_000_000_000);
    expect(parseDecimalToMinor('12.345', 3)).toBe(12_345);
    expect(parseDecimalToMinor('12.3451', 3)).toBeUndefined();
    expect(parseDecimalToMinor('12.001', 2)).toBeUndefined();
    expect(parseDecimalToMinor('12.1', 0)).toBeUndefined();
    expect(sandboxWalkthroughCurrencyExponent('JPY')).toBe(0);
    expect(sandboxWalkthroughCurrencyExponent('BHD')).toBe(3);
  });

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

  it('opens a clean generic intake-held case in the administrator Sandbox walkthrough', async () => {
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
        submissions: [{
          id: 'generic-diagnostic-package',
          format: 'generic-compatibility/1.0',
          state: 'VALIDATED',
          scanner: 'CLEAN'
        }],
        riskFindings: [{
          code: 'UNSUPPORTED_PACKAGE_PROFILE',
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

  it.each([
    {
      currency: 'JPY',
      sourceAccountId: 'source-jpy',
      amount: '1000000000',
      amountMinor: 1_000_000_000,
      exponent: 0,
      pattern: '[0-9]+',
      defaultAmount: '10'
    },
    {
      currency: 'BHD',
      sourceAccountId: 'source-bhd',
      amount: '12.345',
      amountMinor: 12_345,
      exponent: 3,
      pattern: '[0-9]+([.][0-9]{0,3})?',
      defaultAmount: '10.000'
    }
  ])('uses selected $currency account precision for walkthrough input and payload', async ({
    currency,
    sourceAccountId,
    amount,
    amountMinor,
    exponent,
    pattern,
    defaultAmount
  }) => {
    const caseId = `case-${currency.toLowerCase()}-precision`;
    let submitted: unknown;
    const record = {
      id: caseId,
      caseStatus: 'INTAKE_HOLD',
      fundingStatus: 'AWAITING_FUNDS',
      executionStatus: 'NOT_PLANNED',
      submissions: [{
        id: 'generic-diagnostic-package',
        format: 'generic-compatibility/1.0',
        state: 'VALIDATED',
        scanner: 'CLEAN'
      }],
      riskFindings: [{
        code: 'UNSUPPORTED_PACKAGE_PROFILE',
        hardBlock: true,
        message: 'The package is diagnostic only.',
        neededNext: 'Use the Sandbox walkthrough.'
      }],
      providerObservations: [],
      plans: []
    };
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
        nextAction: 'Prepare the Sandbox walkthrough.'
      }])),
      http.get(`/v1/cases/${caseId}`, () => HttpResponse.json(record)),
      http.get('/v1/sandbox/accounts', () => HttpResponse.json([
        { id: 'source-usd', name: 'USD source', currency: 'USD', balanceMinor: 1000, state: 'active' },
        { id: 'target-usd', name: 'USD target', currency: 'USD', balanceMinor: 0, state: 'active' },
        { id: 'source-jpy', name: 'JPY source', currency: 'JPY', balanceMinor: 1000, state: 'active' },
        { id: 'target-jpy', name: 'JPY target', currency: 'JPY', balanceMinor: 0, state: 'active' },
        { id: 'source-bhd', name: 'BHD source', currency: 'BHD', balanceMinor: 1000, state: 'active' },
        { id: 'target-bhd', name: 'BHD target', currency: 'BHD', balanceMinor: 0, state: 'active' }
      ])),
      http.post(`/v1/cases/${caseId}/sandbox-walkthrough`, async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json(record);
      })
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    await screen.findByRole('heading', { name: 'Prepare synthetic Sandbox case inputs' });

    fireEvent.change(screen.getByLabelText('Incoming Sandbox account'), {
      target: { value: sourceAccountId }
    });
    const amountInput = screen.getByLabelText('Test amount');
    await waitFor(() => expect(amountInput).toHaveValue(defaultAmount));
    expect(amountInput).toHaveAttribute('pattern', pattern);
    fireEvent.change(amountInput, { target: { value: amount } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare walkthrough' }));

    await waitFor(() => expect(submitted).toEqual(expect.objectContaining({
      sourceAccountId,
      amountMinor,
      currency,
      exponent
    })));
  });

  it('shows safe package metadata, clean inventory, and actionable finding states', async () => {
    const caseId = 'c5cfd467-41e2-468e-90f0-1a3d5183b220';
    server.use(
      http.get('/v1/cases', () => HttpResponse.json([{
        id: caseId,
        caseStatus: 'INTAKE_HOLD',
        fundingStatus: 'AWAITING_FUNDS',
        executionStatus: 'NOT_PLANNED',
        overallRisk: 'HIGH',
        hardBlockCount: 1,
        updatedAt: '2026-07-28T18:00:00Z',
        nextAction: 'Review the diagnostic findings.'
      }])),
      http.get(`/v1/cases/${caseId}`, () => HttpResponse.json({
        id: caseId,
        caseStatus: 'INTAKE_HOLD',
        fundingStatus: 'AWAITING_FUNDS',
        executionStatus: 'NOT_PLANNED',
        submissions: [{
          id: 'client-package-002',
          version: 2,
          format: 'generic-compatibility/1.0',
          packageSha256: '1234567890abcdef1234567890abcdef',
          state: 'VALIDATED',
          scanner: 'CLEAN',
          receivedAt: '2026-07-28T17:00:00Z'
        }],
        artifacts: [{
          id: 'clean-artifact',
          path: 'intake/summary.json',
          mediaType: 'application/json',
          byteLength: 1200,
          sha256: 'abcdef0123456789abcdef012345cdef',
          scanStatus: 'CLEAN'
        }, {
          id: 'unclean-artifact',
          path: 'unscanned/attachment.txt',
          mediaType: 'text/plain',
          byteLength: 8,
          sha256: 'deadbeef0123456789abcdef0123beef',
          scanStatus: 'UNAVAILABLE'
        }],
        riskFindings: [{
          id: 'profile-finding',
          code: 'UNSUPPORTED_PACKAGE_PROFILE',
          message: 'The package can be inventoried but does not match a transaction-ready adapter.',
          neededNext: 'Confirm the material transaction details with the broker.',
          hardBlock: true
        }, {
          id: 'resolved-finding',
          code: 'MANIFEST_MISSING',
          message: 'The original manifest was not included.',
          neededNext: 'No further action is required for this resolved test finding.',
          hardBlock: false,
          resolvedAt: '2026-07-28T17:30:00Z'
        }],
        fundingExpectation: {
          amountMinor: 12_345,
          currency: 'KWD',
          exponent: 3,
          reference: 'SANDBOX CASE C5CFD467',
          destinationAccountId: 'sandbox-usd-source',
          investorName: 'Redacted test investor'
        },
        providerObservations: [],
        plans: []
      }))
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    expect(await screen.findByRole('heading', { name: 'Submission & package health' })).toBeInTheDocument();
    expect(screen.getByText('generic-compatibility/1.0')).toBeInTheDocument();
    expect(screen.getByText('Validated')).toBeInTheDocument();
    expect(screen.getByText('Clean artifact inventory')).toBeInTheDocument();
    expect(screen.getByText('intake/summary.json')).toBeInTheDocument();
    expect(screen.getByText('application/json')).toBeInTheDocument();
    expect(screen.getByText('1,200 B')).toBeInTheDocument();
    expect(screen.getByText('abcdef012345…cdef')).toBeInTheDocument();
    expect(screen.getByText('KWD 12.345')).toBeInTheDocument();
    expect(screen.queryByText('unscanned/attachment.txt')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Actionable findings' })).toBeInTheDocument();
    expect(screen.getByText('Open finding')).toBeInTheDocument();
    expect(screen.getByText('Resolved finding')).toBeInTheDocument();
    expect(screen.getByText('The package can be inventoried but does not match a transaction-ready adapter.')).toBeInTheDocument();
    expect(screen.getByText('Confirm the material transaction details with the broker.')).toBeInTheDocument();
  });

  it('does not offer synthetic walkthrough inputs for an unsafe package', async () => {
    const caseId = '7be93a47-f7c7-43a0-b00d-c4b794ae6d44';
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
        nextAction: 'Upload a valid ZIP package.'
      }])),
      http.get(`/v1/cases/${caseId}`, () => HttpResponse.json({
        id: caseId,
        caseStatus: 'INTAKE_HOLD',
        fundingStatus: 'AWAITING_FUNDS',
        executionStatus: 'NOT_PLANNED',
        submissions: [{
          id: 'unsafe-upload',
          format: 'generic-compatibility/1.0',
          state: 'FAILED',
          scanner: 'NOT_RUN'
        }],
        riskFindings: [{
          code: 'ARCHIVE_NOT_ZIP',
          message: 'The uploaded file is not a ZIP archive.',
          neededNext: 'Upload the original ZIP package.',
          hardBlock: true
        }],
        providerObservations: [],
        plans: []
      })),
      http.get('/v1/sandbox/accounts', () => HttpResponse.json([]))
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    expect(await screen.findByRole('heading', { name: 'Review the package before continuing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare walkthrough' })).not.toBeInTheDocument();
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
