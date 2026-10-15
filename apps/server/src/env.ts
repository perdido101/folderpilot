import { randomBytes } from "node:crypto";
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Public URL of the web app (CORS + auth trusted origin + links in emails). */
  APP_URL: z.string().url().default("http://localhost:5173"),
  /** Public URL of this API (Better Auth base URL, OAuth callbacks). */
  API_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: optional,
  /** 32 bytes, base64 or hex. Encrypts OAuth tokens and keys at rest (AES-256-GCM). */
  ENCRYPTION_KEY: optional,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  /** Google endpoints; only tests and the E2E suite change these (they point at a mock Google). */
  GOOGLE_OAUTH_URL: optional,
  GOOGLE_TOKEN_URL: optional,
  GOOGLE_REVOKE_URL: optional,
  GOOGLE_DRIVE_API: optional,
  MICROSOFT_CLIENT_ID: optional,
  MICROSOFT_CLIENT_SECRET: optional,
  MICROSOFT_TENANT: optional,
  DROPBOX_APP_KEY: optional,
  DROPBOX_APP_SECRET: optional,
  S3_ENDPOINT: optional,
  S3_BUCKET: optional,
  S3_ACCESS_KEY: optional,
  S3_SECRET: optional,
  S3_REGION: optional,
  ANTHROPIC_API_KEY: optional,
  FP_AI_ANALYSIS_MODEL: z.string().default("claude-haiku-5-5"),
  FP_AI_AGENT_MODEL: z.string().default("claude-opus-5-5"),
  OLLAMA_URL: optional,
  /** Embedding model on OLLAMA_URL for search by meaning when the org's AI can't embed (≤1024 dimensions). */
  FP_EMBED_MODEL: optional,
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  CLAMAV_HOST: optional,
  MCP_PUBLIC_URL: optional,
  /** Development only: a folder on this machine shown as the read-only "Sample files (dev)" space. */
  FP_DEV_SAMPLE_DIR: optional,
  /** Comma-separated emails allowed to change server-wide settings in the app (default: the first account created). */
  FP_ADMIN_EMAILS: optional,
  /** Serve the built web app from this server (single-service deployments), e.g. apps/web/dist. */
  FP_WEB_DIST: optional,
  /** BullMQ key prefix; server and worker must match (tests use their own). */
  FP_QUEUE_PREFIX: z.string().default("bull"),
});

export type Env = z.infer<typeof schema> & { BETTER_AUTH_SECRET: string; ENCRYPTION_KEY: string };

/**
 * Parse and validate configuration. Only Postgres, Redis and two secrets are required; every
 * external account is optional and simply turns its feature off when missing.
 * In development, missing secrets get random per-process values (sessions reset on restart).
 */
export function loadEnv(source: Record<string, string | undefined> = process.env, warn: (msg: string) => void = console.warn): Env {
  // On Render (and similar hosts) the public URL is known at runtime: one origin serves both the app and the API.
  const hosted = source.RENDER_EXTERNAL_URL;
  if (hosted) source = { ...source, APP_URL: source.APP_URL || hosted, API_URL: source.API_URL || hosted };
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration (see .env.example):\n${issues}`);
  }
  const env = parsed.data;
  const secret = (name: "BETTER_AUTH_SECRET" | "ENCRYPTION_KEY", value: string | undefined, gen: () => string) => {
    if (value) return value;
    if (env.NODE_ENV === "production") throw new Error(`${name} is required in production (see .env.example).`);
    warn(`${name} is not set — using a random development value. Set it in .env to keep sessions across restarts.`);
    return gen();
  };
  return {
    ...env,
    BETTER_AUTH_SECRET: secret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET, () => randomBytes(32).toString("base64")),
    ENCRYPTION_KEY: secret("ENCRYPTION_KEY", env.ENCRYPTION_KEY, () => randomBytes(32).toString("base64")),
  };
}

export interface Features {
  auth: { email: boolean; google: boolean; microsoft: boolean };
  connect: { gdrive: boolean; onedrive: boolean; dropbox: boolean };
  cloudStorage: boolean;
  folderpilotAI: boolean;
  ollama: boolean;
  billing: boolean;
  virusScan: boolean;
  mcpHttp: boolean;
}

/** What the UI may show. Anything false is hidden behind a "not configured" notice. */
export function features(env: Env): Features {
  const google = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const microsoft = Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);
  return {
    auth: { email: true, google, microsoft },
    connect: { gdrive: google, onedrive: microsoft, dropbox: Boolean(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET) },
    cloudStorage: Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET),
    folderpilotAI: Boolean(env.ANTHROPIC_API_KEY),
    ollama: Boolean(env.OLLAMA_URL),
    billing: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    virusScan: Boolean(env.CLAMAV_HOST),
    mcpHttp: Boolean(env.MCP_PUBLIC_URL),
  };
}
