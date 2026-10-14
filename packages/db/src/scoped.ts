/**
 * The single org-scoped data-access layer (CLAUDE.md §2.5, §17).
 * Every read/write of tenant data goes through `scoped(db, orgId)`, which always adds
 * `organization_id = $orgId` — callers cannot forget it, and cannot override it on insert.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "./client";

/** Any table with an `organizationId` column. */
export type OrgTable = PgTable & { organizationId: PgColumn };

export interface OrgScope {
  readonly organizationId: string;
  /** `organization_id = orgId AND <cond>` for use in custom queries. */
  where(table: OrgTable, cond?: SQL): SQL;
  select<T extends OrgTable>(table: T, cond?: SQL): Promise<T["$inferSelect"][]>;
  first<T extends OrgTable>(table: T, cond?: SQL): Promise<T["$inferSelect"] | undefined>;
  insert<T extends OrgTable>(table: T, values: Omit<T["$inferInsert"], "organizationId">): Promise<T["$inferSelect"]>;
  update<T extends OrgTable>(table: T, cond: SQL, set: Partial<Omit<T["$inferInsert"], "organizationId">>): Promise<T["$inferSelect"][]>;
}

export function scoped(db: Database, organizationId: string): OrgScope {
  if (!organizationId) throw new Error("scoped() needs an organization id");
  const where = (table: OrgTable, cond?: SQL) => {
    const org = eq(table.organizationId, organizationId);
    return cond ? (and(org, cond) as SQL) : org;
  };
  return {
    organizationId,
    where,
    async select<T extends OrgTable>(table: T, cond?: SQL) {
      return (await db.select().from(table as PgTable).where(where(table, cond))) as T["$inferSelect"][];
    },
    async first<T extends OrgTable>(table: T, cond?: SQL) {
      const rows = (await db.select().from(table as PgTable).where(where(table, cond)).limit(1)) as T["$inferSelect"][];
      return rows[0];
    },
    async insert<T extends OrgTable>(table: T, values: Omit<T["$inferInsert"], "organizationId">) {
      // organizationId is set last so a caller can never write into another org.
      const rows = (await db
        .insert(table)
        .values({ ...values, organizationId } as T["$inferInsert"])
        .returning()) as T["$inferSelect"][];
      return rows[0]!;
    },
    async update<T extends OrgTable>(table: T, cond: SQL, set: Partial<Omit<T["$inferInsert"], "organizationId">>) {
      const { organizationId: _ignored, ...safe } = set as Record<string, unknown>;
      return (await db
        .update(table)
        .set(safe as never)
        .where(where(table, cond))
        .returning()) as T["$inferSelect"][];
    },
  };
}
