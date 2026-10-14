/** Fresh, migrated database for an E2E run (dropped and recreated each time). */
import postgres from "postgres";
import { runMigrations } from "@folderpilot/db";

const admin = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://folderpilot:folderpilot@localhost:5432/folderpilot";
const name = "folderpilot_e2e";
const sql = postgres(admin, { max: 1, onnotice: () => {} });
await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await sql.unsafe(`CREATE DATABASE "${name}"`);
await sql.end();
const url = new URL(admin);
url.pathname = `/${name}`;
await runMigrations(url.toString());
console.log(`E2E database ready: ${name}`);
