import { defineConfig, devices } from "@playwright/test";

/**
 * Config for running QA-Swarm's *own* regression suite (tests/regression and
 * tests/e2e). Generated app tests written by the swarm live under
 * `qa-swarm-out/tests` and can be run with `--config` pointing here.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["github"], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"]],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.QA_BASE_URL ?? "http://localhost:4318",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "api",
      testMatch: /.*\.api\.spec\.ts/,
      use: { baseURL: process.env.QA_BASE_URL ?? "http://localhost:4318" },
    },
    {
      name: "chromium",
      testMatch: /.*\.ui\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.QA_BASE_URL
    ? undefined
    : {
        command: "npm run --workspace examples/demo-app start",
        url: "http://localhost:4318/health",
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});