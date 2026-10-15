/**
 * The whole server pipeline on a real folder, Postgres and Redis:
 * index → analysis (sharp, pdf.js, mammoth) → flags → AI (an OpenAI-compatible mock) → Needs Review.
 */
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AI_SETTINGS } from "@folderpilot/ai";
import { adapterForSpace } from "@folderpilot/adapters";
import { aiUsage, aiInsightCache, createTestDatabase, files, organizations, saveOrgSettings, spaces, type TestDatabase } from "@folderpilot/db";
import { DEFAULT_THRESHOLDS } from "@folderpilot/core";
import { eq } from "drizzle-orm";
import { startWorker, type WorkerRuntime } from "./worker";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const key = Buffer.alloc(32, 3);
let t: TestDatabase;
let dir: string;
let runtime: WorkerRuntime;
let ai: http.Server;
let aiCalls = 0;
let spaceId: string;

async function photo(file: string, block: number, blur = 0) {
  const w = 640;
  const h = 480;
  // Hard-edged blocks (lots of detail), shifted per seed; blurring them is unmistakable.
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = (Math.floor(x / block) + Math.floor(y / block)) % 2 ? 225 : 30;
      raw.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  let img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  if (blur) img = img.blur(blur);
  await img.jpeg({ quality: 90 }).toFile(path.join(dir, file));
}

/** A tiny valid one-page PDF with a line of text. */
function minimalPdf(text: string): string {
  const stream = `BT /F1 18 Tf 50 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out; last value: ${JSON.stringify(Array.isArray(v) ? v.map((f: Record<string, unknown>) => [f.name, Boolean(f.analyzedAt), Boolean(f.aiAnalyzedAt), f.status, f.flags]) : v)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  t = await createTestDatabase("fp_pipeline");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-pipeline-"));
  await fs.mkdir(path.join(dir, "Photos"));
  await photo("Photos/beach.jpg", 8);
  await fs.copyFile(path.join(dir, "Photos/beach.jpg"), path.join(dir, "Photos/beach - Copy.jpg"));
  await photo("Photos/blurry.jpg", 32, 5);
  await fs.writeFile(path.join(dir, "invoice-1001.txt"), "INVOICE 1001 — Alpha Ltd — EUR 1,250.00");
  await fs.writeFile(path.join(dir, "notes.txt"), "unclear scribbles");
  await fs.writeFile(path.join(dir, "statement.pdf"), minimalPdf("Bank statement March 2025"));

  // OpenAI-compatible mock: low confidence for the "unclear" note → Needs Review.
  ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url?.endsWith("/embeddings")) {
        // Search by meaning (not an AI insight call).
        const input = (JSON.parse(body) as { input: string[] }).input;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: input.map((_t, index) => ({ index, embedding: [1, index, 0.5] })) }));
        return;
      }
      aiCalls++;
      const unclear = body.includes("unclear");
      const insight = {
        category: unclear ? "Notes" : body.includes("INVOICE") ? "Invoices" : "Photos",
        tags: ["test"],
        caption: "A file.",
        suggestedName: "Renamed",
        entities: { client: body.includes("Alpha") ? "Alpha Ltd" : null, date: null, amount: null, docType: null },
        confidence: unclear ? 0.3 : 0.9,
        reason: "mock",
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-1", choices: [{ message: { content: JSON.stringify(insight) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => ai.listen(0, "127.0.0.1", r));

  await t.db.insert(organizations).values({ id: "org_p", name: "Pipeline", slug: "pipeline" });
  const [space] = await t.db.insert(spaces).values({ organizationId: "org_p", name: "Sample", mode: "private", adapterId: "local-server", rootRef: dir }).returning();
  spaceId = space!.id;
  await saveOrgSettings(t.db, "org_p", key, {
    ai: { ...DEFAULT_AI_SETTINGS, provider: "openai", openai: { ...DEFAULT_AI_SETTINGS.openai, baseUrl: `http://127.0.0.1:${(ai.address() as AddressInfo).port}`, apiKey: "sk-mock", model: "mock-1" } },
    thresholds: DEFAULT_THRESHOLDS,
    aiMonthlyFileBudget: 100,
  });

  runtime = await startWorker({
    redisUrl,
    heartbeatEveryMs: 3_600_000,
    prefix: `fptest${Date.now()}`,
    concurrency: { analysis: 4, ai: 1 },
    log: (msg, extra) => {
      if (msg === "job failed") console.log("FAILED", JSON.stringify(extra));
    },
    pipeline: {
      db: t.db,
      encryptionKey: key,
      hosted: { analysisModel: "x", agentModel: "y" },
      adapterFor: (s) => adapterForSpace(s, { devSampleDir: dir, production: false }),
    },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await new Promise<void>((r) => (ai ? ai.close(() => r()) : r()));
  await t?.drop();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("server analysis pipeline", () => {
  it("indexes, analyzes (images, text, PDF), flags duplicates/blur, runs AI once per content and sends low confidence to Needs Review", async () => {
    await runtime.queues.indexing.add("index", { orgId: "org_p", spaceId, withAI: true });
    const rows = await until(
      () => t.db.select().from(files).where(eq(files.spaceId, spaceId)),
      (r) => r.length === 6 && r.every((f) => f.analyzedAt && f.aiAnalyzedAt),
    );
    const by = (name: string) => rows.find((f) => f.name === name)!;

    // Local analysis.
    expect(by("beach.jpg")).toMatchObject({ width: 640, height: 480 });
    expect(by("beach.jpg").sha256).toBe(by("beach - Copy.jpg").sha256);
    expect(by("invoice-1001.txt").textExcerpt).toContain("INVOICE 1001");
    expect(by("statement.pdf").textExcerpt).toContain("Bank statement March 2025");

    // Flags (computed once per space after analysis).
    const flags = await until(
      () => t.db.select().from(files).where(eq(files.spaceId, spaceId)),
      (r) => r.some((f) => f.flags.includes("duplicate")) && r.some((f) => f.flags.includes("blurry")),
    );
    expect(flags.filter((f) => f.flags.includes("duplicate"))).toHaveLength(1);
    expect(flags.find((f) => f.name === "blurry.jpg")!.flags).toContain("blurry");

    // AI: every file has an insight, but identical content is described once (cache), and usage is recorded per call.
    const after = await t.db.select().from(files).where(eq(files.spaceId, spaceId));
    expect(after.find((f) => f.name === "notes.txt")).toMatchObject({ status: "needs_review", category: "Notes", confidence: 0.3, aiReason: "mock" });
    expect(after.find((f) => f.name === "invoice-1001.txt")).toMatchObject({ category: "Invoices", status: "analyzed", categorySource: "ai", entities: { client: "Alpha Ltd" }, suggestedName: "Renamed" });
    expect(after.find((f) => f.name === "beach - Copy.jpg")).toMatchObject({ category: "Photos" });
    expect(aiCalls).toBe(5);
    const usage = await t.db.select().from(aiUsage).where(eq(aiUsage.organizationId, "org_p"));
    expect(usage.reduce((n, u) => n + u.files, 0)).toBe(5);
    expect((await t.db.select().from(aiInsightCache)).length).toBe(5);
  }, 60_000);

  it("is idempotent: scanning again changes nothing and calls no AI", async () => {
    const before = aiCalls;
    const job = await runtime.queues.indexing.add("index", { orgId: "org_p", spaceId, withAI: true });
    await until(() => job.getState(), (s) => s === "completed" || s === "unknown");
    await new Promise((r) => setTimeout(r, 1500));
    expect(aiCalls).toBe(before);
  }, 30_000);

  it("picks up an edited file on the next scan", async () => {
    await fs.writeFile(path.join(dir, "invoice-1001.txt"), "INVOICE 1001 — Alpha Ltd — EUR 2,000.00 (corrected)");
    await runtime.queues.indexing.add("index", { orgId: "org_p", spaceId, withAI: false });
    const row = await until(
      async () => (await t.db.select().from(files).where(eq(files.name, "invoice-1001.txt")))[0]!,
      (f) => Boolean(f.analyzedAt) && (f.textExcerpt ?? "").includes("corrected"),
    );
    expect(row.aiAnalyzedAt).toBeNull();
  }, 30_000);
});
