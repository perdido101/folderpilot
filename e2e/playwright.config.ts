import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3100;
const WEB_PORT = 5174;
const ADMIN_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://folderpilot:folderpilot@localhost:5432/folderpilot";
const E2E_DB = Object.assign(new URL(ADMIN_DB), { pathname: "/folderpilot_e2e" }).toString();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Use a preinstalled Chromium when provided (e.g. PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome).
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "pnpm --filter @folderpilot/e2e prepare-db && pnpm --filter @folderpilot/server exec tsx src/index.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: "..",
      env: {
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DB,
        TEST_DATABASE_URL: ADMIN_DB,
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
        APP_URL: `http://localhost:${WEB_PORT}`,
        API_URL: `http://localhost:${API_PORT}`,
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
    },
    {
      command: `pnpm --filter @folderpilot/web exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: "..",
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
