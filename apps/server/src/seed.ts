/**
 * `pnpm db:seed` — demo accounts for local development (idempotent).
 *   owner@folderpilot.local  / folderpilot-demo   (owner of "Demo Office")
 *   editor@folderpilot.local / folderpilot-demo   (editor)
 *   viewer@folderpilot.local / folderpilot-demo   (viewer)
 * With FP_DEV_SAMPLE_DIR set (development only), the org also gets a read-only "Sample files (dev)" space on that folder.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { organizations, spaces, users } from "@folderpilot/db";
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
  const sampleDir = runtime.deps.env.FP_DEV_SAMPLE_DIR;
  if (sampleDir && runtime.deps.env.NODE_ENV !== "production") {
    const root = path.resolve(sampleDir);
    if (!existsSync(root)) {
      console.warn(`FP_DEV_SAMPLE_DIR=${sampleDir} doesn't exist — run \`pnpm sample\` first. Skipping the sample space.`);
    } else {
      const [space] = await db.select().from(spaces).where(and(eq(spaces.organizationId, org!.id), eq(spaces.adapterId, "local-server")));
      if (space) await db.update(spaces).set({ rootRef: root }).where(eq(spaces.id, space.id));
      else await db.insert(spaces).values({ organizationId: org!.id, name: "Sample files (dev)", mode: "private", adapterId: "local-server", rootRef: root, createdBy: ids.owner });
      console.log(`Sample space "Sample files (dev)" → ${root} (read-only). Open it and click Scan.`);
    }
  }
  console.log(`Seeded "Demo Office". Sign in with ${people.map((p) => p.email).join(", ")} — password: ${PASSWORD}`);
} finally {
  await runtime.stop();
}
