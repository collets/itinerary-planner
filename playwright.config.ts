import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: 'http://localhost:5173/api/v1/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
