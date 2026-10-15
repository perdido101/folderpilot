import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ROOT_REF } from "@folderpilot/core";
import { DriveAuthError, GoogleDriveAdapter, type GoogleTokens } from "./index";
import { MockGoogle } from "./mock";

let g: MockGoogle;
let saved: GoogleTokens[] = [];

function adapter(rootId = "root", tokens = g.issueTokens()) {
  return new GoogleDriveAdapter({ rootId, client: { clientId: "id", clientSecret: "secret", tokenUrl: g.urls.tokenUrl }, tokens, apiBase: g.urls.apiBase, backoffMs: 1, onTokens: (t) => void saved.push(t) });
}
const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();

beforeAll(async () => {
  g = new MockGoogle();
  await g.start();
});
afterAll(() => g.stop());
beforeEach(() => {
  saved = [];
  for (const id of [...g.files.keys()]) if (id !== "root-id") g.files.delete(id);
});

describe("Google Drive adapter", () => {
  it("lists everything under the chosen folder with paths; ignores files outside it and non-file Google apps", async () => {
    const office = g.addFolder("Office");
    const clients = g.addFolder("Clients", office);
    g.addFile("inv.pdf", "INVOICE", clients, { mimeType: "application/pdf" });
    g.addFile("Notes", "meeting notes", office, { mimeType: "application/vnd.google-apps.document" });
    g.addFile("form", "", office, { mimeType: "application/vnd.google-apps.form" });
    g.addFile("outside.txt", "x"); // in My Drive, not in Office
    const a = adapter(office);
    const { entries, cursor, complete } = await a.changes();
    expect(complete).toBe(true);
    expect(cursor).toBeTruthy();
    const paths = entries.flatMap((e) => (e.type === "upsert" ? [e.entry.path] : [])).sort();
    expect(paths).toEqual(["Clients", "Clients/inv.pdf", "Notes.gdoc"]);
    const doc = entries.find((e) => e.type === "upsert" && e.entry.name === "Notes.gdoc")!;
    expect(doc.type === "upsert" && doc.entry.version.startsWith("mod:")).toBe(true);
    expect(await text(await a.download((doc as { entry: { ref: { id: string } } }).entry.ref))).toBe("meeting notes");
    expect((await a.resolve("Clients/inv.pdf"))?.version).toMatch(/^md5:/);
    expect(await a.resolve("Notes.gdoc")).not.toBeNull();
    expect(await a.resolve("Nope/x")).toBeNull();
  });

  it("reports only changes since the cursor: edits, moves in and out, renamed folders, trash and deletion", async () => {
    const office = g.addFolder("Office");
    const sub = g.addFolder("Sub", office);
    const keep = g.addFile("keep.txt", "1", sub);
    const gone = g.addFile("gone.txt", "1", office);
    const trashed = g.addFile("old.txt", "1", office);
    const outside = g.addFile("incoming.txt", "1");
    const a = adapter(office);
    const first = await a.changes();

    g.edit(keep, { content: "2" });
    g.remove(gone);
    g.edit(trashed, { trashed: true });
    g.edit(outside, { parents: [office] });
    g.edit(sub, { name: "Renamed" });
    const next = await a.changes(first.cursor);
    expect(next.complete).toBe(false);
    const ups = next.entries.flatMap((e) => (e.type === "upsert" ? [e.entry.path] : []));
    const removed = next.entries.flatMap((e) => (e.type === "removed" ? [e.ref.id] : []));
    expect(ups).toEqual(expect.arrayContaining(["Renamed", "Renamed/keep.txt", "incoming.txt"]));
    expect(removed).toEqual(expect.arrayContaining([gone, trashed]));
    expect((await a.changes(next.cursor)).entries).toEqual([]);
    // An expired cursor falls back to a full listing.
    expect((await a.changes("999999")).complete).toBe(true);
  });

  it("moves and renames in place without overwriting, creates folders once, and checks versions", async () => {
    const a = adapter();
    const file = g.addFile("a.txt", "hello");
    g.addFile("a.txt", "other", g.addFolder("Dest"));
    const entry = (await a.resolve("a.txt"))!;
    const dest = await a.createFolder(ROOT_REF, "Dest");
    expect((await a.createFolder(ROOT_REF, "Dest")).ref.id).toBe(dest.ref.id);
    const moved = await a.move(entry.ref, dest.ref, { expectVersion: entry.version });
    expect(moved.path).toBe("Dest/a (2).txt");
    expect(moved.version).toBe(entry.version); // moves keep the version
    expect(g.pathOf(file)).toBe("Dest/a (2).txt");
    const renamed = await a.rename(moved.ref, "b.txt", { expectVersion: moved.version });
    expect(renamed.path).toBe("Dest/b.txt");
    g.edit(file, { content: "changed in Drive" });
    await expect(a.rename(moved.ref, "c.txt", { expectVersion: moved.version })).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps the .gdoc name in FolderPilot but renames the Google Doc without it", async () => {
    const a = adapter();
    const id = g.addFile("Plan", "text", "root-id", { mimeType: "application/vnd.google-apps.document" });
    const e = (await a.stat({ id }));
    const r = await a.rename(e.ref, "Plan 2026.gdoc", { expectVersion: e.version });
    expect(r.name).toBe("Plan 2026.gdoc");
    expect(g.files.get(id)!.name).toBe("Plan 2026");
  });

  it("trashes into Drive's trash and restores to the original folder (recreated if needed)", async () => {
    const a = adapter();
    const folder = g.addFolder("Projects");
    const id = g.addFile("x.txt", "x", folder);
    const e = await a.stat({ id });
    await a.trash(e.ref, { expectVersion: e.version });
    expect(g.files.get(id)!.trashed).toBe(true);
    g.remove(folder);
    const back = await a.restore({ id }, "Projects/x.txt");
    expect(back.path).toBe("Projects/x.txt");
    expect(g.files.get(id)!.trashed).toBe(false);
  });

  it("refreshes expired access, backs off on rate limits, and reports revoked access", async () => {
    const tokens = { ...g.issueTokens(), expiresAt: Date.now() - 1000 };
    const a = adapter("root", tokens);
    g.addFile("r.txt", "x");
    expect(await a.resolve("r.txt")).not.toBeNull();
    expect(saved).toHaveLength(1); // the new token was handed over to be saved
    g.failNext = { status: 429, count: 2 };
    expect(await a.resolve("r.txt")).not.toBeNull();
    g.accessTokens.clear(); // the access token stops working → refresh on 401
    expect(await a.resolve("r.txt")).not.toBeNull();
    g.refreshTokens.clear(); // revoked
    g.accessTokens.clear();
    await expect(a.resolve("r.txt")).rejects.toBeInstanceOf(DriveAuthError);
  });

  it("stat of a file outside the space is not found; picker helpers list folders and the account", async () => {
    const office = g.addFolder("Office");
    g.addFolder("Inside", office);
    const out = g.addFile("o.txt", "x");
    const a = adapter(office);
    await expect(a.stat({ id: out })).rejects.toBeInstanceOf(NotFoundError);
    expect((await a.folders("root")).map((f) => f.name)).toEqual(["Office"]);
    expect((await a.folders(office)).map((f) => f.name)).toEqual(["Inside"]);
    expect(await a.folderName(office)).toBe("Office");
    expect((await a.account()).email).toBe("you@example.com");
  });
});
