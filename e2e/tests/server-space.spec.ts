/**
 * Server pipeline end to end: seeded owner → organization AI settings → "Sample files (dev)" → Scan & analyze
 * (real worker, mock AI) → Needs Review → Accept (engine) → Audit Log → Undo; Duplicates & Bad Files.
 */
import { expect, test } from "@playwright/test";

test("sample space: analyze with the org's AI, review, accept, audit, undo", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@folderpilot.local");
  await page.getByLabel("Password").fill("folderpilot-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  // Organization AI: OpenAI-compatible endpoint (the mock), key stays on the server.
  await page.goto("/settings");
  await page.getByRole("radio", { name: "Your cloud — OpenAI-compatible" }).click();
  await page.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:3199");
  await page.getByRole("textbox", { name: "Model" }).fill("mock-e2e");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("AI settings saved.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).first().click();
  await expect(page.getByText(/Connected · mock-e2e/)).toBeVisible();

  // Open the server space and run the pipeline.
  await page.getByRole("button", { name: /Sample files \(dev\)/ }).click();
  await page.getByRole("link", { name: "All files" }).click();
  await expect(page.getByText("read-only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan & analyze" }).click();
  await expect(page.getByText("4 of 4 analyzed")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("4 described by AI")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("cell", { name: "Invoices" })).toBeVisible();

  // Needs Review: the unclear note.
  await page.getByRole("link", { name: /Needs Review/ }).click();
  await expect(page.getByText("notes.txt").first()).toBeVisible();
  await expect(page.getByText("30% sure")).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted 1 suggestion")).toBeVisible();
  await expect(page.getByText("Nothing to review.")).toBeVisible();

  // Audit Log: the accept is recorded; Undo adds an undo entry and the file is back in review.
  await page.getByRole("link", { name: "Audit Log" }).click();
  await expect(page.getByText("Accept 1 suggestion")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByText(/undone by user:/)).toBeVisible();
  await page.getByRole("link", { name: /Needs Review/ }).click();
  await expect(page.getByText("notes.txt").first()).toBeVisible();

  // Duplicates & Bad Files: the exact copy, keep-best suggestion; trashing is refused on this read-only space.
  await page.getByRole("link", { name: "Duplicates & Bad Files" }).click();
  await expect(page.getByText("Exact copies")).toBeVisible();
  await expect(page.getByText("beach - Copy.jpg").first()).toBeVisible();
  await page.getByRole("button", { name: "Review one by one" }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText(/read-only/).first()).toBeVisible();
});
