/**
 * `pnpm db:seed` — demo accounts for local development (idempotent).
 *   owner@folderpilot.local  / folderpilot-demo   (owner of "Demo Office")
 *   editor@folderpilot.local / folderpilot-demo   (editor)
 *   viewer@folderpilot.local / folderpilot-demo   (viewer)
 */
import { eq } from "drizzle-orm";
import { organizations, users } from "@folderpilot/db";
import { createDeps } from "./deps";

const PASSWORD = "folderpilot-demo";
const people = [
  { email: "owner@folderpilot.local", name: "Olga Owner", role: "owner" },
  { email: "editor@folderpilot.local", name: "Eleni Editor", role: "editor" },
  { email: "viewer@folderpilot.local", name: "Vasilis Viewer", role: "viewer" },
] as const;

const runtime = createDeps({ ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" });
const { auth, db } = runtime.deps;

async function ensureUser(email: string, name: string): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return existing.id;
  const res = await auth.api.signUpEmail({ body: { email, name, password: PASSWORD } });
  return res.user.id;
}

try {
  const ids = Object.fromEntries(await Promise.all(people.map(async (p) => [p.role, await ensureUser(p.email, p.name)] as const)));
  let [org] = await db.select().from(organizations).where(eq(organizations.slug, "demo-office"));
  if (!org) {
    const created = await auth.api.createOrganization({ body: { name: "Demo Office", slug: "demo-office", userId: ids.owner } });
    if (!created) throw new Error("Could not create the demo organization");
    [org] = await db.select().from(organizations).where(eq(organizations.id, created.id));
  }
  for (const p of people.filter((x) => x.role !== "owner")) {
    await auth.api.addMember({ body: { userId: ids[p.role]!, role: p.role, organizationId: org!.id } }).catch(() => undefined); // already a member
  }
  console.log(`Seeded "Demo Office". Sign in with ${people.map((p) => p.email).join(", ")} — password: ${PASSWORD}`);
} finally {
  await runtime.stop();
}
