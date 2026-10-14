import { describe, expect, it } from "vitest";
import { asDir, FakeDirHandle, withNativeMove } from "@/test/fake-fs";
import { moveFile, uniquePath } from "./fs-ops";

describe.each([
  ["copy + verify + remove fallback", () => new FakeDirHandle("root")],
  ["native FileSystemHandle.move()", () => withNativeMove(new FakeDirHandle("root"))],
])("moveFile (%s)", (_label, makeRoot) => {
  it("moves a file into a new nested folder and keeps the content", async () => {
    const root = makeRoot();
    await root.put("Downloads/invoice.pdf", "PDF-1");
    const final = await moveFile(asDir(root), "Downloads/invoice.pdf", "Clients/Alpha/2024/invoice.pdf");
    expect(final).toBe("Clients/Alpha/2024/invoice.pdf");
    expect(root.paths()).toEqual(["Downloads/", "Clients/Alpha/2024/invoice.pdf"].filter((p) => !p.endsWith("/")));
    expect(await root.read(final)).toBe("PDF-1");
  });

  it("renames in place", async () => {
    const root = makeRoot();
    await root.put("a/IMG_1.jpg", "x");
    expect(await moveFile(asDir(root), "a/IMG_1.jpg", "a/Beach.jpg")).toBe("a/Beach.jpg");
    expect(root.paths()).toEqual(["a/Beach.jpg"]);
  });

  it("never overwrites: appends (2), (3)…", async () => {
    const root = makeRoot();
    await root.put("x/report.docx", "new");
    await root.put("y/report.docx", "old");
    await root.put("y/report (2).docx", "older");
    const final = await moveFile(asDir(root), "x/report.docx", "y/report.docx");
    expect(final).toBe("y/report (3).docx");
    expect(await root.read("y/report.docx")).toBe("old");
    expect(await root.read("y/report (3).docx")).toBe("new");
  });

  it("allows a case-only rename", async () => {
    const root = makeRoot();
    await root.put("notes.txt", "n");
    expect(await moveFile(asDir(root), "notes.txt", "Notes.txt")).toBe("Notes.txt");
    expect(await root.read("Notes.txt")).toBe("n");
  });

  it("is a no-op when source and destination are equal", async () => {
    const root = makeRoot();
    await root.put("a.txt", "a");
    expect(await moveFile(asDir(root), "a.txt", "a.txt")).toBe("a.txt");
    expect(root.paths()).toEqual(["a.txt"]);
  });

  it("throws and leaves everything in place when the source is missing", async () => {
    const root = makeRoot();
    await root.put("b.txt", "b");
    await expect(moveFile(asDir(root), "missing.txt", "c.txt")).rejects.toThrow();
    expect(root.paths()).toEqual(["b.txt"]);
  });
});

describe("uniquePath", () => {
  it("returns the path itself when free", async () => {
    expect(await uniquePath(asDir(new FakeDirHandle("r")), "a/b.txt")).toBe("a/b.txt");
  });
  it("handles files without an extension", async () => {
    const root = new FakeDirHandle("r");
    await root.put("README", "x");
    expect(await uniquePath(asDir(root), "README")).toBe("README (2)");
  });
});
