import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3100;
const WEB_PORT = 5174;
const ADMIN_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://folderpilot:folderpilot@localhost:5432/folderpilot";
const E2E_DB = Object.assign(new URL(ADMIN_DB), { pathname: "/folderpilot_e2e" }).toString();
const SAMPLE_DIR = new URL("./.tmp/sample", import.meta.url).pathname;
const MOCK_AI_PORT = 3199;
/** Mock Google (OAuth + Drive API), served by support/services.ts. */
const MOCK_GOOGLE = "http://127.0.0.1:3198";

/** Shared by the API, the seed and the worker (same DB, encryption key and queue prefix). */
const backendEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
  DATABASE_URL: E2E_DB,
  TEST_DATABASE_URL: ADMIN_DB,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  FP_DEV_SAMPLE_DIR: SAMPLE_DIR,
  FP_QUEUE_PREFIX: "fpe2e",
  GOOGLE_CLIENT_ID: "e2e-client",
  GOOGLE_CLIENT_SECRET: "e2e-secret",
  GOOGLE_OAUTH_URL: `${MOCK_GOOGLE}/o/oauth2/v2/auth`,
  GOOGLE_TOKEN_URL: `${MOCK_GOOGLE}/token`,
  GOOGLE_REVOKE_URL: `${MOCK_GOOGLE}/revoke`,
  GOOGLE_DRIVE_API: `${MOCK_GOOGLE}/drive/v3`,
};

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
      command: "pnpm --filter @folderpilot/e2e prepare-db && pnpm --filter @folderpilot/server exec tsx src/seed.ts && pnpm --filter @folderpilot/server exec tsx src/index.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: "..",
      env: {
        ...backendEnv,
        PORT: String(API_PORT),
        APP_URL: `http://localhost:${WEB_PORT}`,
        API_URL: `http://localhost:${API_PORT}`,
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e",
      },
    },
    {
      // Mock AI + the real worker (analysis, flags, AI jobs).
      command: "pnpm --filter @folderpilot/e2e exec tsx support/services.ts",
      url: `http://127.0.0.1:${MOCK_AI_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: "..",
      env: { ...backendEnv, MOCK_AI_PORT: String(MOCK_AI_PORT) },
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
