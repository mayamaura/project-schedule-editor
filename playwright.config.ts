import { defineConfig } from '@playwright/test';

// Electron の E2E。事前に `npm run build` が必要（out/ を起動する）。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
});
