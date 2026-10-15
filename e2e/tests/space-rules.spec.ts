/**
 * Rules on a server space (runs after server-space.spec, which configures the mock AI and analyzes the sample):
 * an auto rule applies by itself (audited as the rule, undoable); a suggest rule waits in Pending Approvals until approved.
 */
import { expect, test, type Page } from "@playwright/test";

async function newRule(page: Page, opts: { name: string; ext: string; action: string; value: string; auto?: boolean; expectMatches: string }) {
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rule name").fill(opts.name);
  await dialog.getByLabel("Field").selectOption("ext");
  await dialog.getByLabel("Value", { exact: true }).fill(opts.ext);
  await dialog.getByLabel("Action", { exact: true }).selectOption(opts.action);
  await dialog.getByLabel("Action value").fill(opts.value);
  if (opts.auto) await dialog.getByLabel("Mode").selectOption("auto");
  await expect(dialog.getByTestId("rule-test-result")).toContainText(opts.expectMatches);
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText(`Saved rule “${opts.name}”`)).toBeVisible();
}

test("server space: auto rule applies, suggest rule waits for approval, audit and undo", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@folderpilot.local");
  await page.getByLabel("Password").fill("folderpilot-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Sample files \(dev\)/ }).click();

  await page.getByRole("link", { name: "Rules" }).click();
  await newRule(page, { name: "Text files", ext: "txt", action: "tag", value: "text", auto: true, expectMatches: "2 files match" });
  await newRule(page, { name: "Holiday photos", ext: "jpg", action: "set_category", value: "Holiday", expectMatches: "2 files match" });
  await expect(page.getByTestId("rule-row")).toHaveCount(2);
  await expect(page.getByTestId("rule-row").first()).toContainText("Auto");

  await page.getByRole("button", { name: "Run all…" }).click();
  await expect(page.getByText("Auto rules changed 2 files · 2 suggestions are waiting for approval")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();

  // Pending Approvals: the suggestion, with before → after; nothing changed yet.
  await expect(page.getByRole("heading", { name: "Pending approvals" })).toBeVisible();
  const plan = page.getByTestId("server-plan");
  await expect(plan).toContainText("Holiday photos: 2 files");
  await expect(plan).toContainText("by rule");
  await plan.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Nothing waiting for approval")).toBeVisible();

  await page.getByRole("link", { name: "All files" }).click();
  await expect(page.getByRole("cell", { name: "Holiday" })).toHaveCount(2);

  // Audit Log: the auto rule's tags are logged under the rule; undo one.
  await page.getByRole("link", { name: "Audit Log" }).click();
  await expect(page.getByText(/^rule:/).first()).toBeVisible();
  await page.getByText('Rule "Text files"').locator("..").getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undo 2 changes")).toBeVisible();
});
