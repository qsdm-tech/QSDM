import path from 'path';

import { defineConfig } from '@playwright/test';

// End-to-end tests that drive the real Electron app (the production webpack
// build in release/app/dist) with Playwright's _electron support. Build first
// (npm run build), then: npm run test:e2e. Linux CI runs them under xvfb.
// Files are *.e2e.ts, so jest (*.spec.ts) never picks them up.
export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.e2e.ts',
  outputDir: path.join(__dirname, 'test-results'),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(__dirname, 'report') }],
  ],
});
