import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const script = await readFile(
  new URL('../scripts/deploy/run-remote-smoke-test.sh', import.meta.url),
  'utf8'
);

describe('remote Sandbox smoke-test safety', () => {
  it('prepares but never submits a Sandbox transfer', () => {
    expect(script).toContain('/sandbox/internal-transfers/prepare');
    expect(script).toContain('PREPARE ONLY');
    expect(script).toContain('automation-submit-denied');
    expect(script).toContain('[[ "${submit_status}" == "403" ]]');
  });

  it('checks idempotency, persistence, monitoring, backups, and loopback binding', () => {
    expect(script.match(/internal-transfers\/prepare/g)).toHaveLength(2);
    expect(script).toContain('docker restart revolut-api-1');
    expect(script).toContain('/sandbox/monitoring/transfers');
    expect(script).toContain('/sandbox/monitoring/audit-events');
    expect(script).toContain('/sandbox/monitoring/error-report');
    expect(script).toContain('/sandbox/monitoring/errors');
    expect(script).toContain('backup-sandbox-database.sh');
    expect(script).toContain('127.0.0.1:3000');
    expect(script).toContain('smoke_step="text-console"');
    expect(script).toContain('requires an interactive terminal');
  });

  it('requires Sandbox mode and an immutable release commit', () => {
    expect(script).toContain('revolut_mode');
    expect(script).toContain('sandbox');
    expect(script).toContain('^[0-9a-f]{40}$');
  });
});
