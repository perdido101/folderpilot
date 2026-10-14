import { expect, test, type Page } from "@playwright/test";

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function signUp(page: Page, email: string) {
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Olga Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
}

test("sign up → create organization → app shell and theme", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);

  await signUp(page, `owner-${unique()}@example.com`);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Organization name").fill("Papadopoulos Accounting");
  await page.getByRole("button", { name: "Create organization" }).click();

  // Shell (§16): sidebar sections, org switcher with the new org, drop zone empty state.
  await expect(page.getByRole("button", { name: "Organization and account" })).toContainText("Papadopoulos Accounting");
  const nav = page.getByRole("navigation", { name: "Sections" });
  for (const label of ["Needs Review", "Recent", "All Files", "Categories", "Duplicates & Bad Files", "Rules", "Pending Approvals", "Audit Log", "Shared", "Trash", "Settings", "Admin"])
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  await expect(page.getByText("Drop a folder here — or choose one")).toBeVisible();

  // Admin: owner sees members + can invite.
  await nav.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Members & roles" })).toBeVisible();
  await page.getByLabel("Email address").fill(`viewer-${unique()}@example.com`);
  await page.getByLabel("Role").first().selectOption("viewer");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Pending")).toBeVisible();

  // Dark theme.
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Sign out returns to sign-in.
  await page.getByRole("button", { name: "Organization and account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
});

test("device mode works without an account (Private mode in the browser)", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Use on this computer without an account" }).click();
  await expect(page.getByText("Drop a folder here — or choose one")).toBeVisible();

  // Stand-in for the native folder picker: a real directory handle from the origin-private file system.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("demo", { create: true });
    for (const [name, text] of [
      ["invoice-1001.txt", "INVOICE 1001 Alpha Ltd"],
      ["notes.md", "meeting notes"],
      [".DS_Store", "hidden"],
    ]) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => dir;
  });
  await page.getByRole("button", { name: "Choose folder" }).click();
  await expect(page.getByText(/2 files/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});
