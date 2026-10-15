/** Search on "This device": natural query → chips, results, removing a chip, a type filter. */
import { expect, test } from "@playwright/test";

test("device: search with chips and filters", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use on this computer without an account" }).click();
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("search-demo", { create: true });
    for (const [file, text] of [
      ["invoice-77.txt", "INVOICE 77 for Alpha Ltd"],
      ["notes.txt", "meeting notes about the invoice"],
      ["readme.md", "nothing to see"],
    ]) {
      const w = await (await dir.getFileHandle(file!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    }
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
  });
  await page.getByRole("link", { name: "All files" }).click();
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText(/3 files/)).toBeVisible();

  const box = page.getByRole("searchbox", { name: "Search files" });
  await box.fill("invoice this year");
  const results = page.getByTestId("search-results");
  await expect(page.getByTestId("search-chips")).toContainText("Modified:");
  await expect(results.getByRole("button")).toHaveCount(2);
  await expect(results.getByRole("button").first()).toContainText("invoice-77.txt");
  await expect(page.getByText("words only — set up search by meaning")).toBeVisible();

  await page.getByRole("button", { name: "Remove “this year”" }).click();
  await expect(box).toHaveValue("invoice");
  await page.getByLabel("Type").selectOption("document");
  await expect(results.getByRole("button")).toHaveCount(2);
  await box.fill("nothing");
  await expect(results.getByRole("button")).toHaveCount(1);
});
