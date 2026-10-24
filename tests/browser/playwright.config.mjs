import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.mjs",
  outputDir: "../../test-results",
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:18877",
    browserName: "chromium",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/browser/server.mjs",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:18877/api/health",
    timeout: 30000,
    reuseExistingServer: false,
  },
});
