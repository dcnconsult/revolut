import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/operator/session', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 401, json: { error: 'Authentication required.' } });
      return;
    }
    await route.fulfill({
      json: { username: 'viewer', role: 'viewer', csrfToken: 'browser-csrf' }
    });
  });
  await page.route('**/v1/sandbox/monitoring/summary', route => route.fulfill({
    json: { total: 2, byState: { prepared: 2 }, latestUpdatedAt: '2026-07-24T12:00:00.000Z' }
  }));
  await page.route('**/v1/sandbox/operator-status', route => route.fulfill({
    json: { mode: 'sandbox', liveData: false, maximumAmountMinor: 1000, role: 'viewer', generatedAt: '2026-07-24T12:00:00.000Z' }
  }));
  await page.route('**/v1/sandbox/monitoring/transfers?limit=25', route => route.fulfill({
    json: [{ transferRef: 'safe1234', state: 'prepared', amountMinor: 1, currency: 'GBP', reference: 'Test', createdAt: '2026-07-24T12:00:00.000Z', updatedAt: '2026-07-24T12:00:00.000Z' }]
  }));
  await page.route('**/v1/sandbox/monitoring/operator-events?limit=25', route => route.fulfill({ json: [] }));
  await page.route('**/v1/sandbox/monitoring/error-report', route => route.fulfill({
    json: {
      health: 'clear',
      unresolved: 0,
      critical: 0,
      warning: 0,
      retryable: 0,
      totalOccurrences: 0,
      byCategory: {},
      generatedAt: '2026-07-24T12:00:00.000Z'
    }
  }));
  await page.route('**/v1/sandbox/monitoring/errors?limit=25', route => route.fulfill({ json: [] }));
});

test('viewer signs in and receives only the read-only console', async ({ page }) => {
  await page.goto('.');
  await page.getByLabel('Username').fill('viewer');
  await page.getByLabel('Password').fill('not-sent-to-a-server');
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await expect(page.getByRole('heading', { name: 'Sandbox control room' })).toBeVisible();
  await expect(page.getByText('safe1234')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Consolidated operational report' })).toBeVisible();
  await expect(page.getByText('Run a controlled Sandbox transfer')).toHaveCount(0);
  await expect(page.getByText(/NO LIVE DATA/)).toBeVisible();
});

test('login screen has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('.');
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
