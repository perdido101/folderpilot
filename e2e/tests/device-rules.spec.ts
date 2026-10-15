/** An auto rule on "This device" applies by itself after a folder is opened and analyzed (logged and undoable). */
import { expect, test } from "@playwright/test";

test("device: auto rule moves new files after analysis", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use on this computer without an account" }).click();

  await page.getByRole("link", { name: "Rules" }).click();
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rule name").fill("Text to Sorted");
  await dialog.getByLabel("Field").selectOption("ext");
  await dialog.getByLabel("Value", { exact: true }).fill("txt");
  await dialog.getByLabel("Action value").fill("Sorted");
  await dialog.getByLabel("Mode").selectOption("auto");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByTestId("rule-row")).toContainText("Auto");

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("rules-demo", { create: true });
    for (const [file, text] of [
      ["a.txt", "alpha"],
      ["b.txt", "bravo"],
      ["photo.md", "# not text"],
    ]) {
      const w = await (await dir.getFileHandle(file!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    }
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
  });
  await page.getByRole("link", { name: "All files" }).click();
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText("Auto rules changed 2 files")).toBeVisible({ timeout: 30_000 });

  const paths = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("rules-demo");
    const sorted = await dir.getDirectoryHandle("Sorted");
    const out: string[] = [];
    for await (const [name] of (sorted as unknown as { entries(): AsyncIterable<[string]> }).entries()) out.push(name);
    return out.sort();
  });
  expect(paths).toEqual(["a.txt", "b.txt"]);

  await page.getByRole("link", { name: "Audit Log" }).click();
  await expect(page.getByText(/rule:/).first()).toBeVisible();
});
