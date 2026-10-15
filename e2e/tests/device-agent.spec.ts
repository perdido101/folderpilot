/** The agent on "This device": ask from the command palette, get a Plan Card, cancel it — nothing changes on disk. */
import { expect, test } from "@playwright/test";

test("device: ask the agent from the command palette, then cancel its plan", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use on this computer without an account" }).click();

  // AI for this device: the OpenAI-compatible mock (called straight from the browser).
  await page.goto("/settings");
  await page.getByText("Your cloud — OpenAI-compatible").click();
  await page.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:3199");
  await page.getByRole("textbox", { name: /^Model/ }).fill("mock-e2e");

  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("agent-demo", { create: true });
    for (const [file, text] of [
      ["invoice-77.txt", "INVOICE 77"],
      ["notes.txt", "notes"],
    ]) {
      const w = await (await dir.getFileHandle(file!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    }
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
  });
  await page.getByRole("link", { name: "All files" }).click();
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText(/2 files/)).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.keyboard.type("tag the invoice as paid");
  await page.getByText("Ask the agent", { exact: false }).click();

  const reply = page.getByTestId("agent-reply").last();
  await expect(reply).toContainText("It's waiting for your approval.");
  await expect(reply).toContainText("Tag the invoice as paid");
  await reply.getByRole("button", { name: "Cancel" }).click();
  await expect(reply.getByText("cancelled")).toBeVisible();
});
