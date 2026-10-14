import { describe, expect, it } from "vitest";
import { ConflictError, ReadOnlyError, ROOT_REF } from "@folderpilot/core";
import { asDir, FakeDirHandle, withNativeMove } from "@/test/fake-fs";
import { LocalBrowserAdapter, parseVersion, versionOf } from "./local-browser";

async function setup(native = false) {
  const root = new FakeDirHandle("root");
  if (native) withNativeMove(root);
  await root.put("Inbox/a.pdf", "aaa");
  await root.put("Inbox/b.txt", "hello world");
  const adapter = new LocalBrowserAdapter({ kind: "handle", getRoot: async () => asDir(root) });
  return { root, adapter };
}

describe("LocalBrowserAdapter", () => {
  for (const native of [false, true]) {
    describe(native ? "with FileSystemHandle.move()" : "with copy + verify + remove", () => {
      it("stats files with a size-mtime version and resolves folders", async () => {
        const { adapter } = await setup(native);
        const a = await adapter.stat({ id: "Inbox/a.pdf" });
        expect(a).toMatchObject({ path: "Inbox/a.pdf", name: "a.pdf", isFolder: false, size: 3 });
        expect(parseVersion(a.version)).toEqual({ size: 3, mtime: a.mtime });
        expect(await adapter.resolve("Inbox")).toMatchObject({ isFolder: true });
        expect(await adapter.resolve("Nope/x.pdf")).toBeNull();
      });

      it("moves with an optional new name, never overwriting", async () => {
        const { root, adapter } = await setup(native);
        await root.put("Done/a.pdf", "existing");
        const a = await adapter.stat({ id: "Inbox/a.pdf" });
        const moved = await adapter.move(a.ref, { id: "Done" }, { expectVersion: a.version });
        expect(moved.path).toBe("Done/a (2).pdf");
        expect(await root.read("Done/a.pdf")).toBe("existing");
        const b = await adapter.stat({ id: "Inbox/b.txt" });
        const renamedMove = await adapter.move(b.ref, { id: "Done" }, { expectVersion: b.version, newName: "notes.txt" });
        expect(renamedMove.path).toBe("Done/notes.txt");
        expect(root.paths().sort()).toEqual(["Done/a (2).pdf", "Done/a.pdf", "Done/notes.txt"]);
      });

      it("renames in place", async () => {
        const { root, adapter } = await setup(native);
        const a = await adapter.stat({ id: "Inbox/a.pdf" });
        expect((await adapter.rename(a.ref, "Invoice.pdf", { expectVersion: a.version })).path).toBe("Inbox/Invoice.pdf");
        expect(root.paths()).toContain("Inbox/Invoice.pdf");
      });

      it("refuses to change a file edited since it was planned", async () => {
        const { root, adapter } = await setup(native);
        const a = await adapter.stat({ id: "Inbox/a.pdf" });
        await root.put("Inbox/a.pdf", "edited elsewhere");
        await expect(adapter.move(a.ref, ROOT_REF, { expectVersion: a.version })).rejects.toBeInstanceOf(ConflictError);
        await expect(adapter.trash(a.ref, { expectVersion: a.version })).rejects.toBeInstanceOf(ConflictError);
        expect(root.paths()).toContain("Inbox/a.pdf");
      });

      it("trashes into .folderpilot-trash and restores to the original place (or next to it)", async () => {
        const { root, adapter } = await setup(native);
        const a = await adapter.stat({ id: "Inbox/a.pdf" });
        const trashed = await adapter.trash(a.ref, { expectVersion: a.version });
        expect(trashed.path).toBe(".folderpilot-trash/Inbox/a.pdf");
        await root.put("Inbox/a.pdf", "a new file with the same name");
        const back = await adapter.restore(trashed.ref, "Inbox/a.pdf");
        expect(back.path).toBe("Inbox/a (2).pdf");
        expect(await root.read("Inbox/a (2).pdf")).toBe("aaa");
      });
    });
  }

  it("creates nested folders and returns existing ones", async () => {
    const { adapter } = await setup();
    const f = await adapter.createFolder({ id: "Clients" }, "Alpha");
    expect(f).toMatchObject({ path: "Clients/Alpha", isFolder: true });
    expect(await adapter.createFolder({ id: "Clients" }, "Alpha")).toMatchObject({ path: "Clients/Alpha" });
  });

  it("lists a folder (skipping hidden and trash folders) and reads text", async () => {
    const { root, adapter } = await setup();
    await root.put(".folderpilot-trash/old.txt", "x");
    expect((await adapter.list("")).items.map((e) => e.path)).toEqual(["Inbox"]);
    expect((await adapter.list("Inbox")).items.map((e) => e.name).sort()).toEqual(["a.pdf", "b.txt"]);
    expect(await adapter.readText({ id: "Inbox/b.txt" }, 5)).toBe("hello");
  });

  it("read-only folders can be read but never written", async () => {
    const file = new File(["data"], "a.txt", { lastModified: 7 });
    const ro = new LocalBrowserAdapter({ kind: "memory", files: new Map([["Docs/a.txt", file]]) });
    expect(ro.readOnly).toBe(true);
    const a = await ro.stat({ id: "Docs/a.txt" });
    expect(a.version).toBe(versionOf(file));
    expect(await ro.resolve("Docs")).toMatchObject({ isFolder: true });
    await expect(ro.rename(a.ref, "b.txt", { expectVersion: a.version })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(ro.trash(a.ref, { expectVersion: a.version })).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(ro.createFolder(ROOT_REF, "x")).rejects.toBeInstanceOf(ReadOnlyError);
  });

  it("has no delete method", () => {
    const adapter = new LocalBrowserAdapter({ kind: "memory", files: new Map() });
    for (const name of ["delete", "remove", "removeEntry", "purge"]) expect(name in adapter).toBe(false);
  });
});
