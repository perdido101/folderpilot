import { describe, expect, it } from "vitest";
import { features, loadEnv } from "./env";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", REDIS_URL: "redis://localhost:6379" };

describe("loadEnv", () => {
  it("boots with only Postgres + Redis in development (random secrets, with a warning)", () => {
    const warnings: string[] = [];
    const env = loadEnv(base, (m) => warnings.push(m));
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThan(20);
    expect(env.ENCRYPTION_KEY).toBeTruthy();
    expect(env.APP_URL).toBe("http://localhost:5173");
    expect(warnings).toHaveLength(2);
  });

  it("requires secrets in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production" }, () => {})).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it("explains invalid values", () => {
    expect(() => loadEnv({ REDIS_URL: "redis://x" }, () => {})).toThrow(/DATABASE_URL/);
  });

  it("treats blank optional values as not configured", () => {
    const env = loadEnv({ ...base, GOOGLE_CLIENT_ID: "  ", GOOGLE_CLIENT_SECRET: "" }, () => {});
    expect(features(env).auth.google).toBe(false);
  });
});

describe("features", () => {
  it("are all off without external accounts", () => {
    const f = features(loadEnv(base, () => {}));
    expect(f).toEqual({
      auth: { email: true, google: false, microsoft: false },
      connect: { gdrive: false, onedrive: false, dropbox: false },
      cloudStorage: false,
      folderpilotAI: false,
      ollama: false,
      billing: false,
      virusScan: false,
      mcpHttp: false,
    });
  });

  it("turn on only when every required value is present", () => {
    const f = features(
      loadEnv(
        {
          ...base,
          GOOGLE_CLIENT_ID: "g",
          GOOGLE_CLIENT_SECRET: "s",
          MICROSOFT_CLIENT_ID: "m",
          S3_ENDPOINT: "https://r2",
          S3_BUCKET: "b",
          S3_ACCESS_KEY: "a",
          S3_SECRET: "s",
          ANTHROPIC_API_KEY: "k",
          STRIPE_SECRET_KEY: "sk",
        },
        () => {},
      ),
    );
    expect(f.auth.google).toBe(true);
    expect(f.connect.gdrive).toBe(true);
    expect(f.auth.microsoft).toBe(false); // secret missing
    expect(f.cloudStorage).toBe(true);
    expect(f.folderpilotAI).toBe(true);
    expect(f.billing).toBe(false); // webhook secret missing
  });
});
