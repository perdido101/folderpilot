/**
 * `pnpm setup:env` — create .env from .env.example with fresh secrets. Never overwrites an existing .env.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists — leaving it unchanged.");
  process.exit(0);
}
const env = readFileSync(".env.example", "utf8")
  .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`)
  .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
writeFileSync(".env", env, { mode: 0o600 });
console.log("Created .env with new BETTER_AUTH_SECRET and ENCRYPTION_KEY. Next: pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev");
