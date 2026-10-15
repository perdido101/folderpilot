/**
 * Search on server spaces (runs after server-space.spec, which analyzes the sample with the mock AI; the mock also
 * makes embeddings, so search by meaning is on): words + meaning, chips, filters, opening a result.
 */
import { expect, test } from "@playwright/test";

test("server: search by words and meaning, with filters", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@folderpilot.local");
  await page.getByLabel("Password").fill("folderpilot-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Sample files \(dev\)/ }).click();

  const box = page.getByRole("searchbox", { name: "Search files" });
  await box.fill("alpha invoice");
  await expect(page).toHaveURL(/\/search\?q=alpha/);
  const results = page.getByTestId("search-results");
  await expect(results.getByRole("button").first()).toContainText("invoice-1001.txt");
  await expect(results.getByRole("button").first().locator("mark").first()).toBeVisible();

  // "bill" isn't in any file: found by meaning once the worker has embedded the sample.
  await expect(async () => {
    await box.fill("");
    await box.fill("bill");
    await expect(results.getByRole("button").first()).toContainText("invoice-1001.txt", { timeout: 3000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByText("words and meaning")).toBeVisible();
  await expect(results.getByText("by meaning").first()).toBeVisible();

  // Natural query → chip; removing it changes the query; filters narrow results.
  await box.fill("photos");
  await expect(page.getByTestId("search-chips")).toContainText("Type: Images");
  await expect(page.getByTestId("search-total")).toHaveText("2 results");
  await page.getByRole("button", { name: "Remove “photos”" }).click();
  await expect(box).toHaveValue("");
  await page.getByLabel("Type").selectOption("document");
  await expect(page.getByTestId("search-total")).toHaveText("2 results");
  await page.getByLabel("Category").selectOption("Invoices");
  await expect(page.getByTestId("search-total")).toHaveText("1 result");

  await results.getByRole("button").first().click();
  await expect(page.getByRole("textbox", { name: "Search name or path" })).toHaveValue("invoice-1001.txt");
});
