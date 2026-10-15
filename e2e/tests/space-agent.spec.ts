/**
 * The agent on a server space (runs after server-space.spec, which connects the mock AI and analyzes the sample):
 * streamed answer with tool progress → Plan Card → Approve → tag applied → Audit Log under agent: → Undo → Agent activity.
 */
import { expect, test } from "@playwright/test";

test("server space: ask the agent, approve its plan, undo, see its tool calls", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@folderpilot.local");
  await page.getByLabel("Password").fill("folderpilot-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /Sample files \(dev\)/ }).click();
  await page.getByRole("link", { name: "All files" }).click();

  const input = page.getByRole("textbox", { name: "Message the agent" });
  await input.fill("tag the invoice as paid");
  await input.press("Enter");

  const reply = page.getByTestId("agent-reply").last();
  await expect(reply.getByText("Searched files")).toBeVisible();
  await expect(reply.getByText("Proposed changes")).toBeVisible();
  await expect(reply).toContainText("It's waiting for your approval.");
  const card = reply.getByTestId("server-plan");
  await expect(card).toContainText("Tag the invoice as paid");
  await expect(card).toContainText("invoice-1001.txt");
  await expect(card).toContainText("by agent");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("done");

  // The tag is on the file; the change is logged under the agent and can be undone.
  await page.getByRole("link", { name: "Audit Log" }).click();
  // The batch is titled with the plan's reason and attributed to agent:<you>.
  const batch = page.locator("section header").filter({ hasText: "You asked to mark it paid" });
  await expect(batch).toContainText("agent:");
  await batch.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Undo 1 change")).toBeVisible();

  await page.getByRole("tab", { name: "Agent activity" }).click();
  await expect(page.getByTestId("activity-row").filter({ hasText: "search_files" })).toHaveCount(1);
  await expect(page.getByTestId("activity-row").filter({ hasText: "propose_plan" })).toHaveCount(1);

  // Mini mode renders the same conversation for this space.
  await page.goto("/mini");
  await expect(page.getByText("tag the invoice as paid", { exact: true })).toBeVisible();
  await expect(page.getByTestId("server-plan")).toContainText("done");
});
