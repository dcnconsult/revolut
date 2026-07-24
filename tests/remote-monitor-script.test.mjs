import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const monitorScript = await readFile(
  new URL('../scripts/deploy/run-remote-monitor-check.sh', import.meta.url),
  'utf8'
);
const dailyWorkflow = await readFile(
  new URL('../.github/workflows/sandbox-phase2-check.yml', import.meta.url),
  'utf8'
);
const weeklyWorkflow = await readFile(
  new URL('../.github/workflows/sandbox-remote-smoke.yml', import.meta.url),
  'utf8'
);
const offsiteScript = await readFile(
  new URL('../scripts/deploy/upload-offsite-backup.sh', import.meta.url),
  'utf8'
);

describe('scheduled remote operations', () => {
  it('keeps the daily monitor read-only and non-sensitive', () => {
    expect(monitorScript).toContain('run-sandbox-phase2-check.sh');
    expect(monitorScript).toContain('monitoring/summary');
    expect(monitorScript).toContain('sha256sum --check --status');
    expect(monitorScript).not.toContain('/submit');
    expect(monitorScript).not.toContain('/prepare');
  });

  it('monitors service, database, backups, credentials, disk, and network binding', () => {
    for (const expected of [
      'service-health',
      'sandbox-authentication',
      'database-monitoring',
      'backup-freshness',
      'backup-schedule',
      'credential-permissions',
      'disk-capacity',
      '127.0.0.1:3000'
    ]) {
      expect(monitorScript).toContain(expected);
    }
  });

  it('schedules daily monitoring and weekly prepared-only smoke testing', () => {
    expect(dailyWorkflow).toContain('17 6 * * *');
    expect(weeklyWorkflow).toContain('47 4 * * 0');
    expect(dailyWorkflow).toContain('issues: write');
    expect(weeklyWorkflow).toContain('issues: write');
  });

  it('keeps offsite upload disabled until encrypted storage is configured', () => {
    expect(offsiteScript).toContain('OFFSITE_BACKUP_ENABLED');
    expect(offsiteScript).toContain('!= "YES"');
    expect(offsiteScript).toContain('age --encrypt');
    expect(offsiteScript).toContain('rclone');
    expect(offsiteScript).toContain('sha256sum --check --status');
  });
});
