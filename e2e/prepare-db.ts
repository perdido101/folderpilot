/** Fresh, migrated database for an E2E run (dropped and recreated each time), plus a small sample folder for the server space. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import postgres from "postgres";
import { runMigrations } from "@folderpilot/db";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = path.join(here, ".tmp", "sample");

function checker(block: number): Buffer {
  const w = 320;
  const h = 240;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (Math.floor(x / block) + Math.floor(y / block)) % 2 ? 225 : 30;
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 90).data);
}

await fs.rm(SAMPLE_DIR, { recursive: true, force: true });
await fs.mkdir(path.join(SAMPLE_DIR, "Photos"), { recursive: true });
const photo = checker(8);
await fs.writeFile(path.join(SAMPLE_DIR, "Photos", "beach.jpg"), photo);
await fs.writeFile(path.join(SAMPLE_DIR, "Photos", "beach - Copy.jpg"), photo);
await fs.writeFile(path.join(SAMPLE_DIR, "invoice-1001.txt"), "INVOICE 1001 — Alpha Ltd — EUR 1,250.00");
await fs.writeFile(path.join(SAMPLE_DIR, "notes.txt"), "unclear scribbles");

const admin = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://folderpilot:folderpilot@localhost:5432/folderpilot";
const name = "folderpilot_e2e";
const sql = postgres(admin, { max: 1, onnotice: () => {} });
await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await sql.unsafe(`CREATE DATABASE "${name}"`);
await sql.end();
const url = new URL(admin);
url.pathname = `/${name}`;
await runMigrations(url.toString());
console.log(`E2E database ready: ${name}; sample folder: ${SAMPLE_DIR}`);
