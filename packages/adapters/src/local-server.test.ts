import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadOnlyError } from "@folderpilot/core";
import { LocalServerAdapter } from "./local-server";
import { AdapterUnavailableError, adapterForSpace } from "./registry";

let dir: string;
let outside: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "fp-local-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "fp-outside-"));
  await fs.mkdir(path.join(dir, "Inbox"));
  await fs.writeFile(path.join(dir, "Inbox", "a.txt"), "hello world");
  await fs.writeFile(path.join(dir, ".DS_Store"), "x");
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("LocalServerAdapter (read-only in phase 3)", () => {
  it("lists, stats and reads files under the root, skipping hidden files and symlinks", async () => {
    const a = new LocalServerAdapter(dir);
    expect((await a.list("")).items.map((e) => e.path)).toEqual(["Inbox"]);
    const file = await a.stat({ id: "Inbox/a.txt" });
    expect(file).toMatchObject({ name: "a.txt", size: 11, isFolder: false });
    expect(file.version).toMatch(/^11-\d+$/);
    expect(await a.readText({ id: "Inbox/a.txt" }, 5)).toBe("hello");
    const text = await new Response(await a.download({ id: "Inbox/a.txt" })).text();
    expect(text).toBe("hello world");
    expect((await a.changes()).entries).toHaveLength(1);
  });

  it("refuses paths that escape the root", async () => {
    const a = new LocalServerAdapter(dir);
    await expect(a.stat({ id: "../" + path.basename(outside) + "/secret.txt" })).rejects.toThrow(/Invalid path/);
    await expect(a.stat({ id: "/etc/passwd" })).rejects.toThrow(/Invalid path/);
    await expect(a.stat({ id: "link.txt" })).rejects.toThrow(/Invalid path/);
    expect(await a.resolve("nope.txt")).toBeNull();
  });

  it("refuses every write", async () => {
    const a = new LocalServerAdapter(dir);
    await expect(a.move()).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(a.trash()).rejects.toBeInstanceOf(ReadOnlyError);
  });
});

describe("adapterForSpace", () => {
  it("only serves the configured dev sample folder, never in production", () => {
    expect(adapterForSpace({ adapterId: "local-server", rootRef: dir }, { devSampleDir: dir, production: false })).toBeInstanceOf(LocalServerAdapter);
    expect(() => adapterForSpace({ adapterId: "local-server", rootRef: outside }, { devSampleDir: dir, production: false })).toThrow(AdapterUnavailableError);
    expect(() => adapterForSpace({ adapterId: "local-server", rootRef: dir }, { devSampleDir: dir, production: true })).toThrow(/phase 9/);
    expect(() => adapterForSpace({ adapterId: "gdrive", rootRef: "x" }, { production: false })).toThrow(/isn't set up/);
    expect(() => adapterForSpace({ adapterId: "onedrive", rootRef: "x" }, { production: false })).toThrow(/phase 8/);
  });
});
