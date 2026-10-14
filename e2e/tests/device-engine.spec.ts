/**
 * Plan → approve → execute → undo on a real folder in the browser ("This device", Private mode).
 * The folder lives in the origin-private file system, standing in for a folder picked from disk.
 */
import { expect, test, type Page } from "@playwright/test";

const FILES: [string, string][] = [
  ["a.txt", "alpha"],
  ["b.txt", "bravo"],
  ["report.txt", "quarterly report"],
];

async function openDemoFolder(page: Page, name: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use on this computer without an account" }).click();
  await page.evaluate(
    async ({ name, files }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(name, { create: true });
      for (const [file, text] of files) {
        const w = await (await dir.getFileHandle(file, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
      (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
    },
    { name, files: FILES },
  );
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText(/3 files/)).toBeVisible();
}

/** Every file path on disk under the demo folder (including the hidden trash folder). */
function diskPaths(page: Page, name: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      for await (const [entry, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const path = prefix ? `${prefix}/${entry}` : entry;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, path);
        else out.push(path);
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), "");
    return out.sort();
  }, name);
}

async function writeOnDisk(page: Page, name: string, file: string, text: string) {
  await page.evaluate(
    async ({ name, file, text }) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
      const w = await (await dir.getFileHandle(file)).createWritable();
      await w.write(text);
      await w.close();
    },
    { name, file, text },
  );
}

test("move files, then Undo puts them back on disk", async ({ page }) => {
  const folder = `move-${Date.now()}`;
  await openDemoFolder(page, folder);
  await page.getByText("a.txt", { exact: true }).click();
  await page.keyboard.press("Control+a");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByLabel("Destination folder").fill("Archive");
  await page.getByRole("dialog").getByRole("button", { name: "Move" }).click();

  await expect(page.getByText("Moved 3 files")).toBeVisible();
  await expect.poll(() => diskPaths(page, folder)).toEqual(["Archive/a.txt", "Archive/b.txt", "Archive/report.txt"]);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undone · 3 changes reverted")).toBeVisible();
  await expect.poll(() => diskPaths(page, folder)).toEqual(["a.txt", "b.txt", "report.txt"]);

  // The audit log keeps both the change and the undo (append-only).
  await page.getByRole("link", { name: "Audit Log" }).click();
  await expect(page.getByText("Undo 3 changes").first()).toBeVisible();
});

test("trash moves into .folderpilot-trash; restore brings the file back", async ({ page }) => {
  const folder = `trash-${Date.now()}`;
  await openDemoFolder(page, folder);
  await page.getByText("b.txt", { exact: true }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByText("Moved to Trash: 1 file")).toBeVisible();
  await expect.poll(() => diskPaths(page, folder)).toEqual([".folderpilot-trash/b.txt", "a.txt", "report.txt"]);

  await page.getByRole("link", { name: "Trash" }).click();
  await expect(page.getByText("was b.txt")).toBeVisible();
  await expect(page.getByText(/kept at least until/)).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Restored 1 file")).toBeVisible();
  await expect.poll(() => diskPaths(page, folder)).toEqual(["a.txt", "b.txt", "report.txt"]);
});

test("a file edited after the plan was made is a conflict: nothing is overwritten until you decide", async ({ page }) => {
  const folder = `conflict-${Date.now()}`;
  await openDemoFolder(page, folder);
  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByRole("menuitem", { name: "Move into folders by pattern…" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Sorted");
  await page.getByRole("dialog").getByRole("button").filter({ hasText: /Preview plan/ }).click();
  await expect(page.getByRole("heading", { name: "Review plan" })).toBeVisible();

  // Someone edits report.txt in another app while the plan waits for approval.
  await writeOnDisk(page, folder, "report.txt", "quarterly report — edited in another app");
  await page.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByText("1 change needs your decision")).toBeVisible();
  await expect(page.getByText(/changed after this plan was made/)).toBeVisible();
  expect(await diskPaths(page, folder)).toEqual(["Sorted/a.txt", "Sorted/b.txt", "report.txt"]);

  await page.getByRole("button", { name: "Apply to the current file" }).click();
  await expect.poll(() => diskPaths(page, folder)).toEqual(["Sorted/a.txt", "Sorted/b.txt", "Sorted/report.txt"]);
  await expect(page.getByText("1 change needs your decision")).toHaveCount(0);
});
