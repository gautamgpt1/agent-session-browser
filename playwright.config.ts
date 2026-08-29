import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "on-first-retry"
  },
  webServer: {
    command: "node scripts/playwright-dev-server.mjs",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 60_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
