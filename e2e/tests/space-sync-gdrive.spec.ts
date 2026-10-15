/**
 * Google Drive end to end against the mock Google in support/services.ts (runs after the other server-space specs):
 * connect (consent) → pick a folder → scan → a suggest rule's plan → Approve → the file really moves in Drive → Undo →
 * Disconnect (the Drive keeps its files).
 */
import { expect, test } from "@playwright/test";

const driveFiles = async () => ((await (await fetch("http://127.0.0.1:3199/gdrive/files")).json()) as { files: string[]; revoked: number });

test("google drive: connect, organize with approval, undo, disconnect", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@folderpilot.local");
  await page.getByLabel("Password").fill("folderpilot-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /Sample files \(dev\)/ })).toBeVisible();

  // New → Connect a source → Google Drive → (mock) consent → folder picker.
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("menuitem", { name: "Connect a source…" }).click();
  await page.getByRole("button", { name: /Google Drive/ }).click();
  await expect(page).toHaveURL(/\/connect\/gdrive\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Choose what FolderPilot organizes" })).toBeVisible();
  await expect(page.getByText("Signed in as you@example.com")).toBeVisible();
  const folders = page.getByTestId("drive-folders");
  await expect(folders).toContainText("Personal");
  await folders.getByRole("button", { name: "Open Clients" }).click();
  await expect(folders).toContainText("No folders here.");
  await page.getByLabel("Name in FolderPilot").fill("Client Drive");
  await page.getByRole("button", { name: "Use “Clients”" }).click();

  // The scan finds both files; the mock AI analyzes them.
  await expect(page.getByRole("heading", { name: "Client Drive" })).toBeVisible();
  await expect(page.getByText("Google Drive · Clients")).toBeVisible();
  await expect(page.getByRole("cell", { name: "invoice-77.md" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("cell", { name: "Invoices" })).toBeVisible({ timeout: 30_000 });

  // A suggest rule: move .md invoices to "Invoices". Nothing changes in Drive until it's approved.
  await page.getByRole("link", { name: "Rules" }).click();
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rule name").fill("Drive invoices");
  await dialog.getByLabel("Field").selectOption("category");
  await dialog.getByLabel("Value", { exact: true }).fill("Invoices");
  await dialog.getByLabel("Action", { exact: true }).selectOption("move");
  await dialog.getByLabel("Action value").fill("Invoices");
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("Saved rule “Drive invoices”")).toBeVisible();
  await page.getByRole("button", { name: "Run all…" }).click();
  expect((await driveFiles()).files).toContain("Clients/invoice-77.md");

  await page.getByRole("link", { name: "Pending Approvals" }).click();
  const plan = page.getByTestId("server-plan").filter({ hasText: "Drive invoices" });
  await expect(plan).toContainText("Invoices/invoice-77.md");
  await plan.getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await driveFiles()).files, { timeout: 15_000 }).toContain("Clients/Invoices/invoice-77.md");

  // Undo from the Audit Log puts it back in Drive.
  await page.getByRole("link", { name: "Audit Log" }).click();
  await page.locator("section").filter({ hasText: "Invoices/invoice-77.md" }).first().getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await driveFiles()).files, { timeout: 15_000 }).toContain("Clients/invoice-77.md");

  // Quick look offers to open the file in Google Drive.
  await page.getByRole("link", { name: "All files" }).click();
  await page.getByRole("button", { name: /invoice-77\.md/ }).click();
  await expect(page.getByTestId("server-preview")).toContainText("INVOICE 77");
  await expect(page.getByRole("link", { name: "Open in Google Drive" })).toHaveAttribute("href", /^https:\/\/drive\.google\.com\/open\?id=/);
  await page.keyboard.press("Escape");

  // Disconnect: the space goes away, access is revoked, the Drive keeps its files.
  await page.getByRole("button", { name: "Space settings" }).click();
  await page.getByRole("button", { name: "Disconnect…" }).click();
  await expect(page.getByText("Your files in Google Drive stay exactly as they are.")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByText("Disconnected. Your Drive wasn't changed.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Client Drive/ })).toHaveCount(0);
  const after = await driveFiles();
  expect(after.files).toEqual(expect.arrayContaining(["Clients/invoice-77.md", "Clients/meeting.md"]));
  expect(after.files.some((f) => f.includes("(trashed)"))).toBe(false);
  expect(after.revoked).toBe(1);
});
