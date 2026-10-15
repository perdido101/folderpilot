/**
 * Google Drive sync against a mock Drive, Postgres and Redis: a full first scan, then incremental scans from the change
 * feed (new, edited, moved, removed — moves keep their analysis), approved moves/renames really happen in Drive and undo
 * puts them back, trash goes to Drive's trash and restore brings it back, revoked access marks the space "needs reconnect".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adapterForSpace } from "@folderpilot/adapters";
import { MockGoogle } from "@folderpilot/adapters/testing";
import { createEngine, type IndexJob, type StorageAdapter } from "@folderpilot/core";
import { createPgEngineStore, createTestDatabase, files, openCredentials, organizations, saveSpaceTokens, sealCredentials, spaces, users, type TestDatabase } from "@folderpilot/db";
import { indexSpace, connectedSpacesToSync, type PipelineDeps } from "./pipeline/processors";
import { startWorker, type WorkerRuntime } from "./worker";

const ORG = "org_gdrive";
const USER = "user_gdrive";
const key = Buffer.alloc(32, 9);
let t: TestDatabase;
let google: MockGoogle;
let spaceId: string;
let financeId: string;
let inboxId: string;
let runtime: WorkerRuntime | null = null;

const space = async () => (await t.db.select().from(spaces).where(eq(spaces.id, spaceId)))[0]!;
const adapterFor = (s: typeof spaces.$inferSelect): StorageAdapter =>
  adapterForSpace(s, {
    production: false,
    google: { clientId: "c", clientSecret: "s", tokenUrl: google.urls.tokenUrl, apiBase: google.urls.apiBase },
    credentials: {
      open: (r) => openCredentials(key, { id: r.id!, credentialsEncrypted: r.credentialsEncrypted ?? null }),
      save: (r, tokens) => saveSpaceTokens(t.db, key, r.id!, tokens),
    },
    backoffMs: 1,
  });
const deps = (): PipelineDeps => ({
  db: t.db,
  encryptionKey: key,
  hosted: { analysisModel: "x", agentModel: "y" },
  adapterFor,
  enqueueAnalysis: async () => {},
  enqueueFlags: async () => {},
  enqueueAI: async () => {},
});
const scan = async () => indexSpace(deps(), { orgId: ORG, spaceId, withAI: false } satisfies IndexJob);
const indexed = async () => (await t.db.select().from(files).where(eq(files.spaceId, spaceId))).sort((a, b) => a.path.localeCompare(b.path));
const byName = async (name: string) => (await t.db.select().from(files).where(and(eq(files.spaceId, spaceId), eq(files.name, name))))[0]!;
const engine = async () => {
  const s = await space();
  return createEngine({ store: createPgEngineStore(t.db, ORG), adapterFor: async () => adapterFor(s) });
};
const owner = { userId: USER, role: "owner" as const };

beforeAll(async () => {
  t = await createTestDatabase("fp_gdrive_worker");
  google = new MockGoogle();
  await google.start();
  // My Drive: Work/{Finance/invoice.pdf, Inbox/scan.pdf, notes.txt, Plan.gdoc}, Elsewhere/outside.txt
  const work = google.addFolder("Work");
  financeId = google.addFolder("Finance", work);
  inboxId = google.addFolder("Inbox", work);
  google.addFile("invoice.pdf", "INVOICE 1001", financeId, { mimeType: "application/pdf" });
  google.addFile("scan.pdf", "SCAN", inboxId, { mimeType: "application/pdf" });
  google.addFile("notes.txt", "notes", work);
  google.addFile("Plan", "Quarterly plan", work, { mimeType: "application/vnd.google-apps.document" });
  google.addFile("outside.txt", "not in the space", google.addFolder("Elsewhere"));

  await t.db.insert(organizations).values({ id: ORG, name: "Drive", slug: "drive-worker" });
  await t.db.insert(users).values({ id: USER, name: "Owner", email: "owner@drive.test", emailVerified: true });
  const [row] = await t.db.insert(spaces).values({ organizationId: ORG, name: "Google Drive", mode: "connect", adapterId: "gdrive", rootRef: work, settings: {} }).returning();
  spaceId = row!.id;
  await t.db.update(spaces).set({ credentialsEncrypted: sealCredentials(key, spaceId, { kind: "oauth", tokens: google.issueTokens() }) }).where(eq(spaces.id, spaceId));
}, 60_000);

afterAll(async () => {
  await runtime?.stop();
  await google?.stop();
  await t?.drop();
});

describe("Google Drive sync", () => {
  it("the first scan lists everything under the chosen folder (and nothing outside it)", async () => {
    const res = await scan();
    expect(res).toMatchObject({ added: 4, incremental: false });
    expect((await indexed()).map((f) => f.path)).toEqual(["Finance/invoice.pdf", "Inbox/scan.pdf", "notes.txt", "Plan.gdoc"]);
    const s = await space();
    expect(s.syncCursor).toBeTruthy();
    expect(s.settings.lastScanAt).toBeGreaterThan(0);
    expect(await connectedSpacesToSync(t.db)).toEqual([{ orgId: ORG, spaceId }]);
  });

  it("later scans apply only changes: new, edited, moved and removed files; moves keep their analysis", async () => {
    // Pretend the invoice was analyzed.
    const invoice = await byName("invoice.pdf");
    await t.db.update(files).set({ analyzedAt: new Date(), category: "Invoices", status: "analyzed" }).where(eq(files.id, invoice.id));
    const notes = await byName("notes.txt");
    await t.db.update(files).set({ analyzedAt: new Date(), status: "analyzed" }).where(eq(files.id, notes.id));

    google.addFile("new.txt", "fresh", inboxId);
    google.edit(invoice.providerRef, { parents: [inboxId] }); // moved in Drive
    google.edit(notes.providerRef, { content: "edited notes" }); // new content
    google.remove((await byName("scan.pdf")).providerRef); // deleted in Drive
    const callsBefore = google.calls.filter((c) => c.path.endsWith("/files") && c.method === "GET").length;

    const res = await scan();
    expect(res).toMatchObject({ added: 1, changed: 2, removed: 1, incremental: true });
    // No full listing was needed.
    expect(google.calls.filter((c) => c.path.endsWith("/files") && c.method === "GET").length).toBe(callsBefore);
    expect((await indexed()).map((f) => f.path)).toEqual(["Inbox/invoice.pdf", "Inbox/new.txt", "notes.txt", "Plan.gdoc"]);
    const moved = await byName("invoice.pdf");
    expect(moved).toMatchObject({ id: invoice.id, category: "Invoices", status: "analyzed" });
    expect(moved.analyzedAt).not.toBeNull();
    expect((await byName("notes.txt")).analyzedAt).toBeNull();
  });

  it("an approved move and rename really happen in Drive, and undo puts them back", async () => {
    const invoice = await byName("invoice.pdf");
    const notes = await byName("notes.txt");
    const e = await engine();
    const res = await e.run(
      {
        spaceId,
        summary: "Organize",
        steps: [
          { fileId: invoice.id, action: "move", to: "Finance/2026/invoice.pdf" },
          { fileId: notes.id, action: "rename", to: "Meeting notes.txt" },
        ],
      },
      owner,
    );
    expect(res).toMatchObject({ done: 2, failed: 0, conflicted: 0 });
    expect(google.byPath("Work/Finance/2026/invoice.pdf")?.id).toBe(invoice.providerRef);
    expect(google.byPath("Work/Meeting notes.txt")?.id).toBe(notes.providerRef);
    expect((await byName("invoice.pdf")).path).toBe("Finance/2026/invoice.pdf");

    // The change feed reports our own moves; a scan changes nothing.
    expect(await scan()).toMatchObject({ added: 0, removed: 0 });

    const undo = await e.undo({ batchId: res.batchId! }, owner, { spaceId });
    expect(undo).toMatchObject({ done: 2, failed: 0, conflicted: 0 });
    expect(google.byPath("Work/Inbox/invoice.pdf")?.id).toBe(invoice.providerRef);
    expect(google.byPath("Work/notes.txt")?.id).toBe(notes.providerRef);
  });

  it("a file changed in Drive since it was planned is a conflict, not an overwrite", async () => {
    const plan = await byName("new.txt");
    const e = await engine();
    const id = await e.createPlan({ spaceId, source: "user", actor: `user:${USER}`, summary: "Move", steps: [{ fileId: plan.id, action: "move", to: "Finance/new.txt" }] });
    google.edit(plan.providerRef, { content: "changed meanwhile" });
    await e.approve(id, owner);
    const res = await e.execute(id);
    expect(res.conflicted).toBe(1);
    expect(google.byPath("Work/Inbox/new.txt")).toBeDefined();
  });

  it("trash goes to Drive's trash (recoverable) and restore brings it back", async () => {
    const notes = await byName("notes.txt");
    const e = await engine();
    const res = await e.run({ spaceId, summary: "Trash", steps: [{ fileId: notes.id, action: "trash" }] }, owner);
    expect(res.done).toBe(1);
    expect(google.files.get(notes.providerRef)?.trashed).toBe(true);
    // Drive reports it as gone; FolderPilot keeps it as trashed so it can be restored.
    await scan();
    expect((await byName("notes.txt")).status).toBe("trashed");

    const back = await e.run({ spaceId, summary: "Restore", steps: [{ fileId: notes.id, action: "restore" }] }, owner);
    expect(back.done).toBe(1);
    expect(google.files.get(notes.providerRef)?.trashed).toBe(false);
    expect(google.byPath("Work/notes.txt")).toBeDefined();
    expect((await byName("notes.txt")).status).not.toBe("trashed");
  });

  it("revoked access marks the space 'needs reconnect' and stops syncing it", async () => {
    google.refreshTokens.clear();
    google.accessTokens.clear();
    runtime = await startWorker({ redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379", prefix: `fptest${Date.now()}g`, pipeline: { db: t.db, encryptionKey: key, hosted: { analysisModel: "x", agentModel: "y" }, adapterFor } });
    await runtime.queues.indexing.add("index", { orgId: ORG, spaceId, withAI: false } satisfies IndexJob, { jobId: `index_auth_${Date.now()}` });
    const end = Date.now() + 20_000;
    while (!(await space()).settings.needsReconnect && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    expect((await space()).settings.needsReconnect).toBeTruthy();
    expect(await connectedSpacesToSync(t.db)).toEqual([]);
  });
});
