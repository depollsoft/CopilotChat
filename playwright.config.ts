import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4528", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "rm -rf .data/e2e && pnpm build && COPILOT_PROVIDER=echo COPILOTCHAT_DATA_DIR=.data/e2e COPILOTCHAT_HOST=127.0.0.1 COPILOTCHAT_PORT=4528 node apps/server/dist/index.js", url: "http://127.0.0.1:4528/api/health", reuseExistingServer: !process.env.CI, timeout: 120_000 },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  ],
});
