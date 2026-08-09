import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright',
  timeout: 180_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'web',
      testMatch: /web\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4173/StegoShard/',
      },
    },
    {
      name: 'web-firefox',
      testMatch: /web\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
        baseURL: 'http://127.0.0.1:4173/StegoShard/',
      },
    },
    {
      name: 'extension',
      testMatch: /extension\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'npm run preview:web -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/StegoShard/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
