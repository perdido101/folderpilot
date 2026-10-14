/**
 * Test helper: a fresh, fully migrated database per test file, dropped afterwards.
 * Uses TEST_DATABASE_URL (or DATABASE_URL) only to create/drop the throwaway database.
 */
import postgres from "postgres";
import { createDb, type DbHandle } from "./client";
import { runMigrations } from "./migrate";

export interface TestDatabase extends DbHandle {
  url: string;
  drop: () => Promise<void>;
}

export function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL or DATABASE_URL (start Postgres with `pnpm services:up`).");
  return url;
}

export async function createTestDatabase(prefix = "fp_test"): Promise<TestDatabase> {
  const base = new URL(adminUrl());
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const handle = createDb(url.toString(), { max: 5 });
  return {
    ...handle,
    url: url.toString(),
    drop: async () => {
      await handle.close();
      const a = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.end();
    },
  };
}
