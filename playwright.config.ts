import { defineConfig, devices } from '@playwright/test';

// E2E against a running app (local stack by default). Credentials come from env:
//   E2E_EMAIL, E2E_PASSWORD (a local test user created with `pnpm user:create`).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', ...devices['iPhone 15'], browserName: 'chromium' },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: 'pnpm start -p 3000', url: 'http://localhost:3000/login', reuseExistingServer: true, timeout: 120_000 },
});
