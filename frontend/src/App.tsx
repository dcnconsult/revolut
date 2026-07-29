import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, money, type Account, type Session, type Summary, type Transfer } from './api';

interface Status {
  mode: 'sandbox';
  liveData: false;
  maximumAmountMinor: number;
  role: string;
  release?: string;
  backup?: { state: 'fresh' | 'stale' | 'missing' | 'unavailable'; latestAt?: string };
  generatedAt: string;
}

interface OperationalErrorReport {
  health: 'clear' | 'degraded' | 'blocked';
  unresolved: number;
  critical: number;
  warning: number;
  retryable: number;
  totalOccurrences: number;
  byCategory: Record<string, number>;
  latestOccurredAt?: string;
  generatedAt: string;
}

interface OperationalError {
  id: number;
  category: string;
  severity: 'warning' | 'critical';
  operation: string;
  safeMessage: string;
  retryable: boolean;
  httpStatus?: number;
  occurrenceCount: number;
  lastOccurredAt: string;
  resolvedAt?: string;
}

interface OperatorEvent {
  id?: number;
  actor?: string;
  action: string;
  outcome: string;
  transferId?: string;
  transferRef?: string;
  createdAt: string;
}

export function App() {
  const [session, setSession] = useState<Session>();
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api<Session>('/v1/operator/session')
      .then(setSession)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Shell><div className="center-card">Checking secure session…</div></Shell>;
  if (!session) return <Shell><Login onLogin={setSession} /></Shell>;
  return (
    <Shell>
      <header className="topbar">
        <div>
          <p className="eyebrow">Operator console</p>
          <h1>Sandbox control room</h1>
        </div>
        <div className="user-panel">
          <span><strong>{session.username}</strong><small>{session.role === 'admin' ? 'Administrator' : 'Read only'}</small></span>
          <HelpLink />
          <button className="button ghost" onClick={async () => {
            await api('/v1/operator/session', { method: 'DELETE' }, session.csrfToken);
            setSession(undefined);
          }}>Sign out</button>
        </div>
      </header>
      {message && <div className="notice" role="status">{message}<button onClick={() => setMessage('')}>×</button></div>}
      <Dashboard session={session} notify={setMessage} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <><div className="sandbox-banner" role="region" aria-label="Environment warning">REVOLUT SANDBOX · NO LIVE DATA</div><main>{children}</main></>;
}

function HelpLink() {
  return <a
    className="button help-link"
    href="/operator/help/index.html"
    target="_blank"
    rel="noopener noreferrer"
    aria-label="Open operator guide in a new window"
  >Operator guide <span aria-hidden="true">↗</span></a>;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      onLogin(await api<Session>('/v1/operator/session', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          password: data.get('password'),
          totp: data.get('totp')
        })
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }
  return <section className="login-card">
    <div className="login-heading"><p className="eyebrow">Private access</p><HelpLink /></div>
    <h1>Sandbox operator sign in</h1>
    <p>Use the account supplied by your administrator. This console cannot access live Revolut data.</p>
    <form onSubmit={submit}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <label>Authenticator or recovery code<input name="totp" inputMode="numeric" autoComplete="one-time-code" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
    </form>
  </section>;
}

function Dashboard({ session, notify }: { session: Session; notify: (value: string) => void }) {
  const [summary, setSummary] = useState<Summary>();
  const [status, setStatus] = useState<Status>();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [events, setEvents] = useState<OperatorEvent[]>([]);
  const [errorReport, setErrorReport] = useState<OperationalErrorReport>();
  const [operationalErrors, setOperationalErrors] = useState<OperationalError[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [
        nextSummary,
        nextStatus,
        nextTransfers,
        nextEvents,
        nextErrorReport,
        nextOperationalErrors
      ] = await Promise.all([
        api<Summary>('/v1/sandbox/monitoring/summary'),
        api<Status>('/v1/sandbox/operator-status'),
        api<Transfer[]>('/v1/sandbox/monitoring/transfers?limit=25'),
        api<OperatorEvent[]>('/v1/sandbox/monitoring/operator-events?limit=25'),
        api<OperationalErrorReport>('/v1/sandbox/monitoring/error-report'),
        api<OperationalError[]>('/v1/sandbox/monitoring/errors?limit=25')
      ]);
      setSummary(nextSummary);
      setStatus(nextStatus);
      setTransfers(nextTransfers);
      setEvents(nextEvents);
      setErrorReport(nextErrorReport);
      setOperationalErrors(nextOperationalErrors);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Dashboard could not be refreshed.');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return <>
    <CaseWorkflow session={session} notify={async value => { notify(value); await refresh(); }} />
    <section className="status-grid" aria-label="Sandbox status">
      <StatusCard label="Environment" value="Sandbox" detail="Live mode is disabled" tone="green" />
      <StatusCard label="Stored tests" value={String(summary?.total ?? '—')} detail={summary?.latestUpdatedAt ? `Updated ${formatDate(summary.latestUpdatedAt)}` : 'No tests yet'} />
      <StatusCard label="Transfer ceiling" value={status ? money(status.maximumAmountMinor, 'GBP').replace('GBP', '').trim() : '—'} detail="Applied per Sandbox transfer" />
      <StatusCard label="Backup" value={status?.backup ? title(status.backup.state) : '—'} detail={status?.backup?.latestAt ? `Saved ${formatDate(status.backup.latestAt)}` : 'No recent backup timestamp'} tone={status?.backup?.state === 'fresh' ? 'green' : ''} />
      <StatusCard label="Deployment" value={status?.release ?? '—'} detail="Active release identifier" />
      <StatusCard label="Access" value={session.role === 'admin' ? 'Admin' : 'Read only'} detail="Enforced by the server" />
      <StatusCard
        label="Operations"
        value={errorReport ? title(errorReport.health) : '—'}
        detail={errorReport ? `${errorReport.unresolved} unresolved · ${errorReport.totalOccurrences} occurrences` : 'Error report unavailable'}
        tone={errorReport?.health === 'clear' ? 'green' : errorReport?.health ?? ''}
      />
    </section>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="section-intro">
      <p className="eyebrow">Advanced diagnostic</p>
      <h2>Direct owned-account transfer test</h2>
      <p className="muted">This legacy tool is separate from case authorization and cannot use uploaded investor claims.</p>
    </div>
    {session.role === 'admin' && status && <TransferWizard session={session} maximum={status.maximumAmountMinor} onDone={async value => { notify(value); await refresh(); }} />}
    <section className="two-column">
      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Transactions</p><h2>Recent Sandbox activity</h2></div><button className="button ghost" onClick={() => void refresh()}>Refresh</button></div>
        <TransferTable
          transfers={transfers}
          viewer={session.role === 'viewer'}
          onReconcile={session.role === 'admin' ? async id => {
            await api(`/v1/sandbox/internal-transfers/${id}/reconcile`, { method: 'POST' }, session.csrfToken);
            notify('Sandbox transfer status refreshed.');
            await refresh();
          } : undefined}
        />
      </article>
      <article className="panel">
        <p className="eyebrow">Audit trail</p><h2>Recent operator actions</h2>
        <div className="timeline">{events.length === 0 ? <p className="muted">No operator activity recorded.</p> : events.map((event, index) =>
          <div className="timeline-row" key={event.id ?? `${event.createdAt}-${index}`}>
            <span className={`dot ${event.outcome === 'success' ? 'success' : ''}`} />
            <div><strong>{plainAction(event.action)}</strong><small>{event.outcome} · {formatDate(event.createdAt)}</small></div>
          </div>)}</div>
      </article>
    </section>
    <section className="panel operations-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Error monitor</p><h2>Consolidated operational report</h2></div>
        <span className={`pill ${errorReport?.health ?? ''}`}>{errorReport ? title(errorReport.health) : 'Unavailable'}</span>
      </div>
      <p className="muted">
        Messages are redacted before SQLite storage. Repeated failures are consolidated and successful recovery resolves the matching operation.
      </p>
      {operationalErrors.length === 0
        ? <p className="muted">No operational errors have been recorded.</p>
        : <div className="table-wrap"><table><thead><tr><th>Operation</th><th>Category</th><th>Severity</th><th>Count</th><th>Status</th><th>Last seen</th><th>Safe report</th></tr></thead><tbody>
          {operationalErrors.map(item => <tr key={item.id}>
            <td>{plainAction(item.operation)}</td>
            <td>{plainAction(item.category)}</td>
            <td><span className={`pill ${item.severity}`}>{item.severity}</span></td>
            <td>{item.occurrenceCount}</td>
            <td>{item.resolvedAt ? 'Resolved' : item.retryable ? 'Retryable' : 'Operator review'}</td>
            <td>{formatDate(item.lastOccurredAt)}</td>
            <td className="message-cell">{item.safeMessage}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </>;
}

function StatusCard({ label, value, detail, tone = '' }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className="status-card"><span className={`status-light ${tone}`} /><p>{label}</p><strong>{value}</strong><small>{detail}</small></article>;
}

interface CaseSummary {
  id: string;
  caseStatus: string;
  fundingStatus: string;
  executionStatus: string;
  overallRisk: string;
  hardBlockCount: number;
  updatedAt: string;
  nextAction: string;
}

interface CaseRiskFinding {
  id?: string;
  code: string;
  message: string;
  neededNext: string;
  hardBlock: boolean;
  severity?: string;
  createdAt?: string;
  resolvedAt?: string;
  resolvedByAmendmentId?: string;
}

interface CasePackageProfile {
  id?: string;
  version?: string;
  label?: string;
  name?: string;
  confidence?: string;
}

interface CasePackageHealth {
  state?: string;
  status?: string;
  scanner?: string;
  scanStatus?: string;
  profile?: CasePackageProfile | string;
  packageProfile?: CasePackageProfile | string;
  message?: string;
}

interface CaseSubmission {
  id: string;
  version?: number;
  packageSha256?: string;
  format?: string;
  profile?: CasePackageProfile | string;
  packageProfile?: CasePackageProfile | string;
  state?: string;
  scanner?: string;
  receivedAt?: string;
  completedAt?: string;
}

interface CaseArtifact {
  id?: string;
  submissionId?: string;
  path: string;
  mediaType?: string;
  byteLength?: number;
  sha256?: string;
  scanStatus?: string;
}

interface CaseClaim {
  id?: string;
  path: string;
  value: unknown;
  source?: string;
  recordedAt?: string;
}

interface CaseAmendment {
  id?: string;
  version?: number;
  reason: string;
  source: string;
  claims?: Array<{ path: string; value: unknown }>;
  resolvesFindingCodes?: string[];
  recordedAt?: string;
}

interface CaseBrokerFinding {
  id?: string;
  category: string;
  outcome: 'PASS' | 'CONCERN' | 'BLOCK';
  note: string;
  recordedAt?: string;
}

interface CaseDecision {
  outcome: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION';
  reason: string;
  actor?: string;
  decidedAt?: string;
}

interface CaseFundingExpectation {
  amountMinor: number;
  currency: string;
  exponent: number;
  reference: string;
  destinationAccountId: string;
  investorName: string;
}

interface CaseProviderObservation extends CaseFundingExpectation {
  id: string;
  accountId: string;
  direction: 'CREDIT' | 'DEBIT';
  state: string;
}

interface CasePlan {
  version: number;
  digest: string;
  status: string;
}

interface CaseRecord {
  id: string;
  caseStatus: string;
  fundingStatus: string;
  executionStatus: string;
  submissions?: CaseSubmission[];
  packageProfile?: CasePackageProfile | string;
  packageHealth?: CasePackageHealth;
  artifacts?: CaseArtifact[];
  riskFindings?: CaseRiskFinding[];
  claims?: CaseClaim[];
  amendments?: CaseAmendment[];
  brokerFindings?: CaseBrokerFinding[];
  decision?: CaseDecision;
  fundingExpectation?: CaseFundingExpectation;
  providerObservations: CaseProviderObservation[];
  plans: CasePlan[];
}

// The case walkthrough sends integer minor units. Keep this explicit and
// fail closed for an account currency that has not been reviewed for this UI.
const SANDBOX_WALKTHROUGH_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  BHD: 3,
  CHF: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  TND: 3,
  USD: 2
});

function CaseWorkflow({
  session,
  notify
}: {
  session: Session;
  notify: (message: string) => Promise<void>;
}) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedCase, setSelectedCase] = useState<CaseRecord>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const load = useCallback(() => api<CaseSummary[]>('/v1/cases?limit=50')
    .then(setCases)
    .catch(caught => setError(caught instanceof Error ? caught.message : 'Case inbox could not be loaded.')), []);
  useEffect(() => { void load(); }, [load]);

  async function openCase(caseId: string) {
    setBusy(true);
    setError('');
    try {
      const [record, ownedAccounts] = await Promise.all([
        api<CaseRecord>(`/v1/cases/${caseId}`),
        session.role === 'admin' ? api<Account[]>('/v1/sandbox/accounts') : Promise.resolve([])
      ]);
      setSelectedCase(record);
      setAccounts(ownedAccounts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Case details could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshSelected(message: string) {
    if (!selectedCase) return;
    const record = await api<CaseRecord>(`/v1/cases/${selectedCase.id}`);
    setSelectedCase(record);
    await load();
    await notify(message);
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await api<{ caseId: string }>('/v1/cases/submissions', {
        method: 'POST',
        body: data
      }, session.csrfToken);
      form.reset();
      await notify(`Package stored in quarantine. Case ${result.caseId.slice(0, 8)} is being checked.`);
      window.setTimeout(() => void load(), 250);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Package upload failed.');
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    'Upload package',
    'Review package health',
    'Compare claims and findings',
    'Add cited evidence',
    'Match incoming credit',
    'Approve or reject',
    'Review payouts and fees',
    'Authorize and execute',
    'Reconcile and export'
  ];
  return <section className="panel case-workflow">
    <div className="panel-heading">
      <div><p className="eyebrow">Human-governed cases</p><h2>Funding case inbox</h2></div>
      <button className="button ghost" onClick={() => void load()}>Refresh inbox</button>
    </div>
    <ol className="workflow-steps" aria-label="Case workflow">
      {steps.map((step, index) => <li key={step}><span>{index + 1}</span>{step}</li>)}
    </ol>
    {session.role === 'admin' && <form className="upload-row" onSubmit={upload}>
      <label>Private ZIP package<input name="package" type="file" accept=".zip,application/zip" required /></label>
      <button className="button primary" disabled={busy}>{busy ? 'Storing safely…' : 'Upload to quarantine'}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {cases.length === 0
      ? <p className="muted">No brokered-funding cases have been received.</p>
      : <div className="table-wrap"><table><thead><tr>
          <th>Case</th><th>Case review</th><th>Funds</th><th>Execution</th><th>Risk</th><th>What is needed next</th><th>Action</th>
        </tr></thead><tbody>{cases.map(item => <tr key={item.id}>
          <td><code>{item.id.slice(0, 8)}</code><small>{formatDate(item.updatedAt)}</small></td>
          <td><span className={`pill ${item.caseStatus.toLowerCase()}`}>{plainAction(item.caseStatus)}</span></td>
          <td>{plainAction(item.fundingStatus)}</td>
          <td>{plainAction(item.executionStatus)}</td>
          <td>{plainAction(item.overallRisk)} · {item.hardBlockCount} block{item.hardBlockCount === 1 ? '' : 's'}</td>
          <td className="message-cell">{item.nextAction}</td>
          <td><button className="button ghost" disabled={busy} onClick={() => void openCase(item.id)}>Open case</button></td>
        </tr>)}</tbody></table></div>}
    {selectedCase && <CaseDetail
      record={selectedCase}
      accounts={accounts}
      session={session}
      onClose={() => setSelectedCase(undefined)}
      onChanged={refreshSelected}
    />}
  </section>;
}

function CaseDetail({
  record,
  accounts,
  session,
  onClose,
  onChanged
}: {
  record: CaseRecord;
  accounts: Account[];
  session: Session;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [walkthroughSourceAccountId, setWalkthroughSourceAccountId] = useState('');
  const [walkthroughAmount, setWalkthroughAmount] = useState('');
  const findings = record.riskFindings ?? [];
  const activeFindings = findings.filter(item => !item.resolvedAt);
  const latestPlan = record.plans.at(-1);
  const expectation = record.fundingExpectation;
  const latestSubmission = record.submissions?.at(-1);
  const canPrepareSandboxWalkthrough = latestSubmission?.format === 'generic-compatibility/1.0' &&
    latestSubmission.state === 'VALIDATED' && latestSubmission.scanner === 'CLEAN';
  const matchedObservation = expectation
    ? record.providerObservations.find(item =>
        item.direction === 'CREDIT' &&
        item.accountId === expectation.destinationAccountId &&
        item.currency === expectation.currency &&
        item.amountMinor === expectation.amountMinor &&
        item.reference === expectation.reference &&
        item.state.toUpperCase() === 'COMPLETED'
      )
    : undefined;
  const sourceCandidates = accounts.filter(source =>
    source.state === 'active' &&
    accounts.some(target =>
      target.id !== source.id && target.state === 'active' && target.currency === source.currency
    )
  );
  const selectedWalkthroughSource = sourceCandidates.find(account =>
    account.id === walkthroughSourceAccountId
  ) ?? sourceCandidates[0];
  const walkthroughExponent = selectedWalkthroughSource
    ? sandboxWalkthroughCurrencyExponent(selectedWalkthroughSource.currency)
    : undefined;
  const payoutTargets = expectation
    ? accounts.filter(account =>
        account.id !== expectation.destinationAccountId &&
        account.state === 'active' &&
        account.currency === expectation.currency
      )
    : [];

  useEffect(() => {
    setWalkthroughAmount(walkthroughExponent === undefined
      ? ''
      : defaultWalkthroughAmount(walkthroughExponent));
  }, [selectedWalkthroughSource?.id, walkthroughExponent]);

  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      await onChanged(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Sandbox case action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function prepareWalkthrough(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = selectedWalkthroughSource;
    const exponent = walkthroughExponent;
    const amountMinor = exponent === undefined
      ? undefined
      : parseDecimalToMinor(walkthroughAmount, exponent);
    if (!source || exponent === undefined || amountMinor === undefined) {
      setError(exponent === undefined
        ? 'The selected Sandbox account currency has no reviewed minor-unit precision for this walkthrough.'
        : `Select a Sandbox account and enter a positive amount with no more than ${exponent} decimal places.`);
      return;
    }
    await perform(
      () => api(`/v1/cases/${record.id}/sandbox-walkthrough`, {
        method: 'POST',
        body: JSON.stringify({
          sourceAccountId: source.id,
          amountMinor,
          currency: source.currency,
          exponent
        })
      }, session.csrfToken),
      'Sandbox-only case inputs prepared. The uploaded package remains in the audit trail but is not relied upon.'
    );
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!expectation || !matchedObservation) return;
    const data = new FormData(event.currentTarget);
    const target = payoutTargets.find(item => item.id === data.get('targetAccountId'));
    if (!target) {
      setError('Select an eligible owned Sandbox payout account.');
      return;
    }
    await perform(
      () => api(`/v1/cases/${record.id}/plans`, {
        method: 'POST',
        body: JSON.stringify({
          receiptObservationId: matchedObservation.id,
          allocations: [{
            kind: 'CUSTOMER_PAYOUT',
            amountMinor: expectation.amountMinor,
            currency: expectation.currency,
            exponent: expectation.exponent,
            beneficiaryName: target.name,
            reference: `SANDBOX PAYOUT ${record.id.slice(0, 8).toUpperCase()}`,
            method: 'OWNED_ACCOUNT_TRANSFER',
            sourceAccountId: expectation.destinationAccountId,
            targetAccountId: target.id
          }]
        })
      }, session.csrfToken),
      'Exactly balanced Sandbox transfer plan created.'
    );
  }

  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!latestPlan) return;
    const data = new FormData(event.currentTarget);
    await perform(
      () => api(`/v1/cases/${record.id}/plans/${latestPlan.version}/authorize`, {
        method: 'POST',
        body: JSON.stringify({
          password: data.get('password'),
          totp: data.get('totp'),
          confirmation: `AUTHORIZE ${record.id} PLAN ${latestPlan.version} ${latestPlan.digest.slice(0, 12)}`
        })
      }, session.csrfToken),
      'Sandbox plan authorized.'
    );
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!latestPlan) return;
    const data = new FormData(event.currentTarget);
    await perform(
      () => api(`/v1/cases/${record.id}/plans/${latestPlan.version}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          password: data.get('password'),
          totp: data.get('totp'),
          confirmation: `EXECUTE ${record.id} PLAN ${latestPlan.version} ${latestPlan.digest.slice(0, 12)}`
        })
      }, session.csrfToken),
      'Sandbox transfer submitted. Reconcile the provider result next.'
    );
  }

  return <section className="case-runner case-detail" aria-label="Selected funding case">
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Selected case</p>
        <h2>Case detail · <code>{record.id.slice(0, 8)}</code></h2>
      </div>
      <div className="actions">
        <button className="button ghost" disabled={busy} onClick={() => void onChanged('Case status refreshed.')}>Refresh</button>
        <button className="button ghost" onClick={onClose}>Close</button>
      </div>
    </div>
    <div className="case-status-strip">
      <span><small>Case</small><strong>{plainAction(record.caseStatus)}</strong></span>
      <span><small>Funds</small><strong>{plainAction(record.fundingStatus)}</strong></span>
      <span><small>Execution</small><strong>{plainAction(record.executionStatus)}</strong></span>
      <span><small>Open findings</small><strong>{activeFindings.length}</strong></span>
    </div>
    <CasePackageOverview record={record} />
    <CaseFindings findings={findings} />
    <BrokerCaseReview
      record={record}
      accounts={accounts}
      session={session}
      busy={busy}
      onAction={perform}
    />
    <section className="sandbox-walkthrough" aria-labelledby="sandbox-walkthrough-heading">
      <div className="detail-section-heading">
        <div>
          <p className="eyebrow">Controlled option</p>
          <h3 id="sandbox-walkthrough-heading">Sandbox walkthrough</h3>
        </div>
      </div>
      <p className="sandbox-walkthrough-note">
        <strong>Sandbox only.</strong> This walkthrough uses synthetic instructions and owned Revolut Sandbox accounts.
        It never treats the uploaded package as cleared evidence and cannot reach live funds.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {session.role !== 'admin'
      ? <p className="muted">Read-only accounts can review this case but cannot advance it.</p>
      : record.caseStatus === 'CLOSED'
        ? <div className="runner-step complete">
            <p className="eyebrow">Complete</p>
            <h3>Sandbox case reconciled and closed</h3>
            <p>Download the signed evidence bundle for the complete case history.</p>
            <a className="button help-link" href={`/v1/cases/${record.id}/evidence`} download>Download signed evidence</a>
          </div>
        : !expectation && !canPrepareSandboxWalkthrough
          ? <div className="runner-step">
              <p className="eyebrow">Diagnostic intake hold</p>
              <h3>Review the package before continuing</h3>
              <p>
                The Sandbox walkthrough is available only for a clean ZIP in the generic compatibility profile.
                Unsafe, unscanned, or transaction-ready packages cannot use synthetic walkthrough inputs.
              </p>
            </div>
        : !expectation
          ? <div className="runner-step">
              <p className="eyebrow">Step 1</p>
              <h3>Prepare synthetic Sandbox case inputs</h3>
              <p>This explicitly supplies Sandbox-only diagnostic inputs; it never clears or trusts the uploaded package claims.</p>
              <form className="prepare-form" onSubmit={prepareWalkthrough}>
                <label>Incoming Sandbox account
                  <select
                    name="sourceAccountId"
                    value={selectedWalkthroughSource?.id ?? ''}
                    onChange={event => setWalkthroughSourceAccountId(event.currentTarget.value)}
                    required
                  >
                    {sourceCandidates.map(account =>
                      <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>
                    )}
                  </select>
                </label>
                <label>Test amount
                  <input
                    name="amount"
                    type="text"
                    inputMode={walkthroughExponent === 0 ? 'numeric' : 'decimal'}
                    pattern={walkthroughAmountPattern(walkthroughExponent)}
                    value={walkthroughAmount}
                    onChange={event => setWalkthroughAmount(event.currentTarget.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <button className="button primary" disabled={busy || !selectedWalkthroughSource || walkthroughExponent === undefined}>
                  Prepare walkthrough
                </button>
              </form>
              {sourceCandidates.length === 0 &&
                <p className="error">Two active owned Sandbox accounts in the same currency are required.</p>}
              {selectedWalkthroughSource && walkthroughExponent === undefined &&
                <p className="error">{selectedWalkthroughSource.currency} has no reviewed minor-unit precision for this walkthrough.</p>}
            </div>
          : record.fundingStatus !== 'MATCHED'
            ? <div className="runner-step">
                <p className="eyebrow">Step 2</p>
                <h3>Create and match the Sandbox test credit</h3>
                <p>
                  Create a clearly labelled {caseMoney(expectation.amountMinor, expectation.currency, expectation.exponent)} Sandbox credit,
                  then match it to this case.
                </p>
                <button className="button primary" disabled={busy} onClick={() => void perform(
                  () => api(`/v1/cases/${record.id}/funding-observations/refresh`, {
                    method: 'POST',
                    body: JSON.stringify({ simulate: true })
                  }, session.csrfToken),
                  'Sandbox test credit created and matched.'
                )}>Create and match test credit</button>
              </div>
            : record.caseStatus !== 'APPROVED'
              ? <div className="runner-step">
                  <p className="eyebrow">Step 3</p>
                  <h3>Record the Sandbox broker decision</h3>
                  <p>Funding is matched and the synthetic walkthrough findings are clear.</p>
                  <button className="button primary" disabled={busy} onClick={() => void perform(
                    () => api(`/v1/cases/${record.id}/decisions`, {
                      method: 'POST',
                      body: JSON.stringify({
                        outcome: 'APPROVE',
                        reason: 'Approved for explicit Sandbox-only workflow simulation after matched synthetic funding.'
                      })
                    }, session.csrfToken),
                    'Sandbox broker decision recorded.'
                  )}>Approve Sandbox case</button>
                </div>
              : !latestPlan
                ? <div className="runner-step">
                    <p className="eyebrow">Step 4</p>
                    <h3>Create the exact owned-account transfer plan</h3>
                    <p>The payout uses the complete matched receipt; there are no fees or retained funds in this walkthrough.</p>
                    <form className="prepare-form" onSubmit={createPlan}>
                      <label>Destination Sandbox account
                        <select name="targetAccountId" required>
                          {payoutTargets.map(account =>
                            <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>
                          )}
                        </select>
                      </label>
                      <label>Exact payout
                        <input value={caseMoney(expectation.amountMinor, expectation.currency, expectation.exponent)} readOnly />
                      </label>
                      <button className="button primary" disabled={busy || payoutTargets.length === 0}>Create plan</button>
                    </form>
                  </div>
                : latestPlan.status === 'AWAITING_AUTHORIZATION'
                  ? <div className="runner-step">
                      <p className="eyebrow">Step 5</p>
                      <h3>Authorize the exact Sandbox plan</h3>
                      <p>Plan {latestPlan.version} · digest <code>{latestPlan.digest.slice(0, 12)}</code></p>
                      <form key="authorize-plan" className="reauth-form" onSubmit={authorize}>
                        <label>Administrator password<input name="password" type="password" autoComplete="current-password" required /></label>
                        <label>Fresh authenticator code<input name="totp" inputMode="numeric" autoComplete="one-time-code" required /></label>
                        <button className="button primary" disabled={busy}>Authorize plan</button>
                      </form>
                    </div>
                  : latestPlan.status === 'AUTHORIZED' && record.executionStatus === 'AUTHORIZED'
                    ? <div className="runner-step">
                        <p className="eyebrow">Step 6</p>
                        <h3>Execute the authorized Sandbox transfer</h3>
                        <p>Re-enter your administrator password and a fresh authenticator code.</p>
                        <form key="execute-plan" className="reauth-form" onSubmit={execute}>
                          <label>Administrator password<input name="password" type="password" autoComplete="current-password" required /></label>
                          <label>Fresh authenticator code<input name="totp" inputMode="numeric" autoComplete="one-time-code" required /></label>
                          <button className="button primary" disabled={busy}>Execute once</button>
                        </form>
                      </div>
                    : <div className="runner-step">
                        <p className="eyebrow">Step 7</p>
                        <h3>Reconcile and close</h3>
                        <p>Refresh the submitted payout from Revolut Sandbox and close the case when it is complete.</p>
                        <div className="actions">
                          <button className="button primary" disabled={busy} onClick={() => void perform(
                            () => api(`/v1/cases/${record.id}/reconcile`, { method: 'POST' }, session.csrfToken),
                            'Sandbox provider results reconciled.'
                          )}>Reconcile Sandbox result</button>
                          <a className="button help-link" href={`/v1/cases/${record.id}/evidence`} download>Download current evidence</a>
                        </div>
                        </div>}
    </section>
  </section>;
}

function CasePackageOverview({ record }: { record: CaseRecord }) {
  const submission = record.submissions?.at(-1);
  const artifacts = record.artifacts ?? [];
  const cleanArtifacts = artifacts.filter(item => item.scanStatus === 'CLEAN');
  const profile = describePackageProfile(
    record.packageHealth?.packageProfile ??
    record.packageHealth?.profile ??
    record.packageProfile ??
    submission?.packageProfile ??
    submission?.profile ??
    submission?.format
  );
  const packageState = record.packageHealth?.status ?? record.packageHealth?.state ?? submission?.state;
  const scanStatus = record.packageHealth?.scanStatus ?? record.packageHealth?.scanner ?? submission?.scanner;

  return <>
    <section className="case-detail-section" aria-labelledby="package-health-heading">
      <div className="detail-section-heading">
        <div>
          <p className="eyebrow">Diagnostic intake</p>
          <h3 id="package-health-heading">Submission &amp; package health</h3>
        </div>
      </div>
      <div className="case-detail-grid">
        <div className="detail-fact">
          <span>Latest submission</span>
          <strong>{submission ? <code>{submission.id}</code> : 'Not reported'}</strong>
          <small>{submission?.receivedAt ? `Received ${formatDate(submission.receivedAt)}` : 'No submission timestamp reported.'}</small>
        </div>
        <div className="detail-fact">
          <span>Profile</span>
          <strong>{profile}</strong>
          <small>{submission?.version ? `Submission version ${submission.version}` : 'Profile classification is shown when available.'}</small>
        </div>
        <div className="detail-fact">
          <span>Package health</span>
          <strong>{displayCaseState(packageState, 'Not reported')}</strong>
          <small>{record.packageHealth?.message ?? 'Archive safety and validation state.'}</small>
        </div>
        <div className="detail-fact">
          <span>Scan status</span>
          <strong>{displayCaseState(scanStatus, 'Not reported')}</strong>
          <small>Only clean artifacts are listed below.</small>
        </div>
        <div className="detail-fact">
          <span>Package digest</span>
          <strong><code>{shortDigest(submission?.packageSha256)}</code></strong>
          <small>Short identifier for the encrypted original package.</small>
        </div>
        {record.fundingExpectation && <div className="detail-fact">
          <span>Expected funding</span>
          <strong>{caseMoney(
            record.fundingExpectation.amountMinor,
            record.fundingExpectation.currency,
            record.fundingExpectation.exponent
          )}</strong>
          <small>Declared amount, pending broker confirmation and observed funding.</small>
        </div>}
      </div>
    </section>
    <section className="case-detail-section" aria-labelledby="artifact-inventory-heading">
      <div className="detail-section-heading">
        <div>
          <p className="eyebrow">Safe metadata</p>
          <h3 id="artifact-inventory-heading">Clean artifact inventory</h3>
        </div>
        <span className="pill clear">{cleanArtifacts.length} clean</span>
      </div>
      {cleanArtifacts.length === 0
        ? <p className="muted">
            {artifacts.length === 0
              ? 'No clean artifact inventory has been reported for this case.'
              : 'Artifact inventory remains unavailable until the corresponding artifact scan is clean.'}
          </p>
        : <div className="table-wrap"><table className="artifact-table"><thead><tr>
            <th>Path</th><th>Type</th><th>Size</th><th>Scan</th><th>Digest</th>
          </tr></thead><tbody>{cleanArtifacts.map((artifact, index) => <tr key={`${artifact.id ?? artifact.sha256 ?? artifact.path}-${index}`}>
            <td className="artifact-path"><code>{artifact.path}</code></td>
            <td>{artifact.mediaType ?? 'Not reported'}</td>
            <td>{formatByteLength(artifact.byteLength)}</td>
            <td><span className="pill clean">Clean</span></td>
            <td><code>{shortDigest(artifact.sha256)}</code></td>
          </tr>)}</tbody></table></div>}
      <p className="inventory-note">Artifact contents are never displayed in this console.</p>
    </section>
  </>;
}

function CaseFindings({ findings }: { findings: CaseRiskFinding[] }) {
  return <section className="case-detail-section" aria-labelledby="case-findings-heading">
    <div className="detail-section-heading">
      <div>
        <p className="eyebrow">Review queue</p>
        <h3 id="case-findings-heading">Actionable findings</h3>
      </div>
      <span className="pill">{findings.length} total</span>
    </div>
    {findings.length === 0
      ? <p className="muted">No machine or broker findings have been reported for this case.</p>
      : <div className="case-findings">{findings.map((finding, index) => {
          const resolved = Boolean(finding.resolvedAt);
          return <article className={`case-finding ${resolved ? 'resolved' : 'open'}`} key={finding.id ?? `${finding.code}-${index}`}>
            <div className="finding-heading">
              <div>
                <p className="eyebrow">{plainAction(finding.code)}</p>
                <h4>{resolved ? 'Resolved finding' : 'Open finding'}</h4>
              </div>
              <span className={`pill ${resolved ? 'clear' : finding.hardBlock ? 'blocked' : 'warning'}`}>
                {resolved ? 'Resolved' : 'Open'}
              </span>
            </div>
            <p><strong>Message:</strong> {finding.message || 'No safe finding message was reported.'}</p>
            <p><strong>Needed next:</strong> {finding.neededNext || 'Review this finding with the broker.'}</p>
            {finding.resolvedAt && <small>Resolved {formatDate(finding.resolvedAt)}{finding.resolvedByAmendmentId ? ' by amendment' : ''}.</small>}
          </article>;
        })}</div>}
  </section>;
}

function BrokerCaseReview({
  record,
  accounts,
  session,
  busy,
  onAction
}: {
  record: CaseRecord;
  accounts: Account[];
  session: Session;
  busy: boolean;
  onAction: (action: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const latestSubmission = record.submissions?.at(-1);
  const cleanGenericPackage = latestSubmission?.format === 'generic-compatibility/1.0' &&
    latestSubmission.state === 'VALIDATED' && latestSubmission.scanner === 'CLEAN';
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [formError, setFormError] = useState('');
  const destinationAccount = accounts.find(account => account.id === destinationAccountId);
  const destinationExponent = destinationAccount
    ? sandboxWalkthroughCurrencyExponent(destinationAccount.currency)
    : undefined;
  const genericFindingCodes = new Set([
    'MANIFEST_MISSING',
    'MANIFEST_PARSE_FAILED',
    'UNSUPPORTED_PACKAGE_PROFILE',
    'UNSUPPORTED_ARTIFACT_TYPE',
    'REQUIRED_TRANSACTION_FIELD_NOT_FOUND'
  ]);
  const resolvesGenericFindings = (record.riskFindings ?? [])
    .filter(finding => !finding.resolvedAt && genericFindingCodes.has(finding.code))
    .map(finding => finding.code);

  useEffect(() => {
    const firstCompatible = accounts.find(account =>
      account.state === 'active' && sandboxWalkthroughCurrencyExponent(account.currency) !== undefined
    );
    setDestinationAccountId(current =>
      accounts.some(account => account.id === current) ? current : firstCompatible?.id ?? '');
  }, [accounts, record.id]);

  async function confirmIncomingCredit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const account = accounts.find(item => item.id === String(data.get('destinationAccountId') ?? ''));
    const exponent = account ? sandboxWalkthroughCurrencyExponent(account.currency) : undefined;
    const amountMinor = exponent === undefined ? undefined : parseDecimalToMinor(data.get('amount'), exponent);
    if (!account || exponent === undefined || amountMinor === undefined) {
      setFormError('Choose an active Sandbox destination account and enter a positive amount at that currency’s supported precision.');
      return;
    }
    setFormError('');
    await onAction(() => api(`/v1/cases/${record.id}/amendments`, {
      method: 'POST',
      body: JSON.stringify({
        reason: data.get('reason'),
        source: data.get('source'),
        claims: [
          {
            path: 'expectedIncomingCredit',
            value: {
              amountMinor,
              currency: account.currency,
              exponent,
              reference: data.get('reference'),
              destinationAccountId: account.id,
              investorName: data.get('investorLegalName')
            }
          },
          { path: 'investor.legalName', value: data.get('investorLegalName') },
          { path: 'beneficiary.legalName', value: data.get('beneficiaryLegalName') },
          { path: 'authority.reference', value: data.get('authorityReference') },
          { path: 'purpose', value: data.get('purpose') }
        ],
        resolvesFindingCodes: resolvesGenericFindings,
        evidenceRefs: [data.get('evidenceRef')]
      })
    }, session.csrfToken), 'Broker-confirmed incoming funding details recorded; independently observe the provider credit next.');
  }

  async function addReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onAction(() => api(`/v1/cases/${record.id}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        category: data.get('category'),
        outcome: data.get('outcome'),
        note: data.get('note'),
        evidenceRefs: [data.get('evidenceRef')]
      })
    }, session.csrfToken), 'Broker review finding recorded.');
  }

  async function recordDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onAction(() => api(`/v1/cases/${record.id}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ outcome: data.get('outcome'), reason: data.get('reason') })
    }, session.csrfToken), 'Broker case decision recorded.');
  }

  return <section className="case-detail-section broker-case-review" aria-labelledby="broker-case-review-heading">
    <div className="detail-section-heading">
      <div>
        <p className="eyebrow">Human review</p>
        <h3 id="broker-case-review-heading">Broker review &amp; amendments</h3>
      </div>
      {record.decision && <span className={`pill ${record.decision.outcome === 'APPROVE' ? 'approved' : 'warning'}`}>
        {plainAction(record.decision.outcome)}
      </span>}
    </div>
    <p className="inventory-note">
      Confirmed case facts are entered as cited amendments. The diagnostic ZIP remains evidence only; this form never treats it as transaction-ready instructions.
    </p>
    {formError && <p className="error" role="alert">{formError}</p>}

    <div className="broker-review-history">
      <div>
        <strong>Claims recorded</strong>
        <small>{record.claims?.length ?? 0} metadata claim{(record.claims?.length ?? 0) === 1 ? '' : 's'} · values remain in the protected case record.</small>
      </div>
      <div>
        <strong>Amendments</strong>
        <small>{record.amendments?.length ?? 0} cited amendment{(record.amendments?.length ?? 0) === 1 ? '' : 's'}</small>
      </div>
      <div>
        <strong>Broker findings</strong>
        <small>{record.brokerFindings?.length ?? 0} review finding{(record.brokerFindings?.length ?? 0) === 1 ? '' : 's'}</small>
      </div>
    </div>

    {(record.claims?.length ?? 0) > 0 && <details>
      <summary>View submitted and amended claim values</summary>
      <ul>
        {record.claims?.map(claim => <li key={claim.id ?? `${claim.path}-${claim.recordedAt}`}>
          <code>{claim.path}</code> · {plainAction(claim.source ?? 'recorded')} · {claimValueSummary(claim.value)}
        </li>)}
      </ul>
    </details>}

    {(record.amendments?.length ?? 0) > 0 && <details>
      <summary>View amendment history</summary>
      <ul>
        {record.amendments?.map(amendment => <li key={amendment.id ?? `${amendment.version}-${amendment.recordedAt}`}>
          <strong>{amendment.source}</strong> · {amendment.reason}
          {amendment.resolvesFindingCodes?.length ? ` · resolves ${amendment.resolvesFindingCodes.map(plainAction).join(', ')}` : ''}
        </li>)}
      </ul>
    </details>}
    {(record.brokerFindings?.length ?? 0) > 0 && <details>
      <summary>View broker review history</summary>
      <ul>
        {record.brokerFindings?.map(finding => <li key={finding.id ?? `${finding.category}-${finding.recordedAt}`}>
          <strong>{plainAction(finding.outcome)}</strong> · {finding.category}: {finding.note}
        </li>)}
      </ul>
    </details>}

    {session.role !== 'admin'
      ? <p className="muted">Read-only accounts can review cited case history but cannot amend, review, or decide a case.</p>
      : <div className="broker-review-actions">
          {cleanGenericPackage && !record.fundingExpectation && <form className="broker-confirm-form" onSubmit={confirmIncomingCredit}>
            <div className="detail-section-heading">
              <div><p className="eyebrow">Clean generic ZIP</p><h4>Confirm real-case inputs</h4></div>
            </div>
            <p className="muted">Use independently verified broker facts; cite the review evidence reference below.</p>
            <label>Confirmed destination Sandbox account
              <select name="destinationAccountId" value={destinationAccountId} onChange={event => setDestinationAccountId(event.currentTarget.value)} required>
                {accounts.filter(account => account.state === 'active').map(account =>
                  <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>
                )}
              </select>
            </label>
            <label>Confirmed incoming amount
              <input name="amount" inputMode={destinationExponent === 0 ? 'numeric' : 'decimal'} pattern={walkthroughAmountPattern(destinationExponent)} required />
            </label>
            <label>Confirmed reference<input name="reference" maxLength={140} required /></label>
            <label>Investor legal name<input name="investorLegalName" maxLength={200} required /></label>
            <label>Beneficiary legal name<input name="beneficiaryLegalName" maxLength={200} required /></label>
            <label>Authority reference<input name="authorityReference" maxLength={200} required /></label>
            <label>Purpose<input name="purpose" maxLength={500} required /></label>
            <label>Evidence reference<input name="evidenceRef" maxLength={300} required /></label>
            <label>Amendment source<input name="source" defaultValue="Designated broker review" maxLength={300} required /></label>
            <label>Reason<input name="reason" defaultValue="Broker confirmed full-value Sandbox case inputs from cited review evidence." maxLength={500} required /></label>
            <button className="button primary" disabled={busy || !destinationAccount || destinationExponent === undefined}>Record cited incoming funding amendment</button>
          </form>}

          <form className="broker-review-form" onSubmit={addReview}>
            <div className="detail-section-heading"><div><p className="eyebrow">Review record</p><h4>Add broker finding</h4></div></div>
            <label>Category<input name="category" maxLength={100} placeholder="Identity, authority, payout structure…" required /></label>
            <label>Outcome<select name="outcome" defaultValue="PASS"><option value="PASS">Pass</option><option value="CONCERN">Concern</option><option value="BLOCK">Block</option></select></label>
            <label>Review note<input name="note" maxLength={1000} required /></label>
            <label>Evidence reference<input name="evidenceRef" maxLength={300} required /></label>
            <button className="button ghost" disabled={busy}>Record broker finding</button>
          </form>

          {!['CLOSED', 'REJECTED'].includes(record.caseStatus) && <form className="broker-decision-form" onSubmit={recordDecision}>
            <div className="detail-section-heading"><div><p className="eyebrow">Decision</p><h4>Record broker decision</h4></div></div>
            <label>Outcome<select name="outcome" defaultValue="REQUEST_INFORMATION"><option value="REQUEST_INFORMATION">Request information</option><option value="REJECT">Reject</option><option value="APPROVE">Approve after matched funding</option></select></label>
            <label>Decision reason<input name="reason" maxLength={1000} required /></label>
            <button className="button ghost" disabled={busy}>Record decision</button>
          </form>}
        </div>}
  </section>;
}

function TransferWizard({ session, maximum, onDone }: { session: Session; maximum: number; onDone: (message: string) => Promise<void> }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [prepared, setPrepared] = useState<Transfer>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Account[]>('/v1/sandbox/accounts').then(setAccounts).catch(error => setError(error.message)); }, []);
  const pairs = useMemo(() => accounts.flatMap(source => accounts
    .filter(target => target.id !== source.id && target.currency === source.currency && target.state === 'active')
    .map(target => ({ source, target }))), [accounts]);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    const pair = pairs[Number(data.get('pair'))];
    if (!pair) { setError('Choose an eligible account pair.'); setBusy(false); return; }
    const amountMinor = Math.round(Number(data.get('amount')) * 100);
    try {
      setPrepared(await api<Transfer>('/v1/sandbox/internal-transfers/prepare', {
        method: 'POST',
        body: JSON.stringify({
          sourceAccountId: pair.source.id,
          targetAccountId: pair.target.id,
          amountMinor,
          currency: pair.source.currency,
          reference: 'SANDBOX OPERATOR CONSOLE TEST',
          clientReference: crypto.randomUUID()
        })
      }, session.csrfToken));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Preparation failed.'); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prepared?.id || !prepared.request) return;
    setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      const result = await api<Transfer>(`/v1/sandbox/internal-transfers/${prepared.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          password: data.get('password'),
          totp: data.get('totp'),
          confirmation: data.get('confirmation')
        })
      }, session.csrfToken);
      setPrepared(undefined);
      await onDone(`Sandbox transfer submitted. Current state: ${result.state}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Submission failed.'); }
    finally { setBusy(false); }
  }

  if (prepared?.request) {
    const phrase = `SUBMIT ${(prepared.request.amountMinor / 100).toFixed(2)} ${prepared.request.currency}`;
    return <section className="panel action-panel">
      <p className="eyebrow danger-text">Final Sandbox confirmation</p><h2>Review before submitting</h2>
      <div className="review"><span>Amount<strong>{money(prepared.request.amountMinor, prepared.request.currency)}</strong></span><span>Environment<strong>Sandbox only</strong></span><span>Status<strong>Prepared — not sent</strong></span></div>
      <form onSubmit={submit}>
        <label>Re-enter your admin password<input name="password" type="password" autoComplete="current-password" required /></label>
        <label>Fresh authenticator or recovery code<input name="totp" inputMode="numeric" autoComplete="one-time-code" /></label>
        <label>Type <code>{phrase}</code><input name="confirmation" autoComplete="off" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" className="button ghost" onClick={() => setPrepared(undefined)}>Cancel</button><button className="button danger" disabled={busy}>{busy ? 'Submitting…' : 'Submit Sandbox transfer'}</button></div>
      </form>
    </section>;
  }
  return <section className="panel action-panel">
    <p className="eyebrow">Admin action</p><h2>Run a controlled Sandbox transfer</h2>
    <p>Preparation validates the accounts and amount without moving test funds. You will review a separate confirmation screen before submission.</p>
    <form className="prepare-form" onSubmit={prepare}>
      <label>Eligible account pair<select name="pair" required defaultValue=""><option value="" disabled>Select source and destination</option>{pairs.map((pair, index) =>
        <option key={`${pair.source.id}-${pair.target.id}`} value={index}>{pair.source.name} → {pair.target.name} · {pair.source.currency}</option>)}</select></label>
      <label>Sandbox amount<input name="amount" type="number" min="0.01" max={(maximum / 100).toFixed(2)} step="0.01" defaultValue="0.01" required /></label>
      <button className="button primary" disabled={busy || pairs.length === 0}>{busy ? 'Validating…' : 'Prepare test'}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function TransferTable({
  transfers,
  viewer,
  onReconcile
}: {
  transfers: Transfer[];
  viewer: boolean;
  onReconcile?: (id: string) => Promise<void>;
}) {
  if (transfers.length === 0) return <p className="muted">No Sandbox transfers have been recorded.</p>;
  return <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Updated</th>{onReconcile && <th>Action</th>}</tr></thead><tbody>{transfers.map((transfer, index) => {
    const amount = transfer.request?.amountMinor ?? transfer.amountMinor ?? 0;
    const currency = transfer.request?.currency ?? transfer.currency ?? 'GBP';
    const canReconcile = transfer.id && ['submitted', 'pending'].includes(transfer.state);
    return <tr key={transfer.id ?? transfer.transferRef ?? index}><td><code>{viewer ? transfer.transferRef : transfer.id?.slice(0, 8)}</code></td><td>{money(amount, currency)}</td><td><span className={`pill ${transfer.state}`}>{transfer.state}</span></td><td>{formatDate(transfer.updatedAt)}</td>{onReconcile && <td>{canReconcile ? <button className="button ghost" onClick={() => void onReconcile(transfer.id!)}>Refresh status</button> : '—'}</td>}</tr>;
  })}</tbody></table></div>;
}

export function parseDecimalToMinor(value: FormDataEntryValue | null, exponent: number): number | undefined {
  if (typeof value !== 'string' || !Number.isInteger(exponent) || exponent < 0 || exponent > 9) return undefined;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) return undefined;
  const minor = BigInt(whole) * (10n ** BigInt(exponent)) + BigInt(fraction.slice(0, exponent).padEnd(exponent, '0') || '0');
  if (minor < 1n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(minor);
}

export function sandboxWalkthroughCurrencyExponent(currency: string): number | undefined {
  return SANDBOX_WALKTHROUGH_CURRENCY_EXPONENTS[currency.trim().toUpperCase()];
}

function defaultWalkthroughAmount(exponent: number) {
  return exponent === 0 ? '10' : `10.${'0'.repeat(exponent)}`;
}

function walkthroughAmountPattern(exponent: number | undefined) {
  if (exponent === undefined) return '[0-9]+';
  return exponent === 0 ? '[0-9]+' : `[0-9]+([.][0-9]{0,${exponent}})?`;
}

function caseMoney(amountMinor: number, currency: string, exponent: number) {
  return `${currency} ${minorUnitsToDecimal(amountMinor, exponent)}`;
}

function claimValueSummary(value: unknown) {
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 237)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
  } catch {
    return 'Structured value unavailable';
  }
}

function minorUnitsToDecimal(amountMinor: number, exponent: number) {
  if (!Number.isSafeInteger(amountMinor) || !Number.isInteger(exponent) || exponent < 0 || exponent > 9) {
    return String(amountMinor);
  }
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor));
  if (exponent === 0) return `${sign}${groupDigits(digits)}`;
  const padded = digits.padStart(exponent + 1, '0');
  return `${sign}${groupDigits(padded.slice(0, -exponent))}.${padded.slice(-exponent)}`;
}

function describePackageProfile(profile: CasePackageProfile | string | undefined) {
  if (!profile) return 'Not classified';
  if (typeof profile === 'string') return profile;
  const name = profile.label ?? profile.name ?? profile.id ?? 'Not classified';
  return profile.version ? `${name} · v${profile.version}` : name;
}

function displayCaseState(value: string | undefined, fallback: string) {
  return value ? plainAction(value.toLowerCase()) : fallback;
}

function formatByteLength(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? `${groupDigits(String(value))} B`
    : '—';
}

function shortDigest(value: string | undefined) {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

function groupDigits(value: string) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function plainAction(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
