import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 12_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"], ["html", { open: "never" }]],
  outputDir: "test-results",
  webServer: [
    {
      command: "pnpm --filter @vyzync/server dev",
      cwd: repositoryRoot,
      url: "http://127.0.0.1:8787/health",
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node tests/fixtures/fixture-server.mjs",
      cwd: repositoryRoot,
      url: "http://127.0.0.1:4173/single.html",
      timeout: 15_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
