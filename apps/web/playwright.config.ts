import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a running Project Hub (API + worker + web), e.g. `pnpm dev`.
 *   E2E_BASE_URL   default http://localhost:3100
 *   E2E_EMAIL / E2E_PASSWORD   an organization admin (pnpm admin:create)
 *   E2E_DEPLOY_DIR folder under DEPLOY_LOCAL_ROOTS / <STORAGE_DIR>/deploy-local for the local deploy target
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 6 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    locale: 'tr-TR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 950 } } }],
});
