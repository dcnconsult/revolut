import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:5173/operator/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'npm run dev:console -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/operator/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
