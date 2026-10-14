import { describe, expect, it } from "vitest";
import { can, isRole, ROLE_GRANTS, STATEMENTS } from "./permissions";
import { roleAtLeast, ROLES } from "./types";

describe("roles and permissions", () => {
  it("orders roles owner > admin > editor > viewer", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("editor", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
  });

  it("only owners delete the organization or manage billing", () => {
    for (const role of ROLES) {
      expect(can(role, "organization", "delete")).toBe(role === "owner");
      expect(can(role, "billing", "manage")).toBe(role === "owner");
    }
  });

  it("viewers can look and propose but never change files or approve", () => {
    expect(can("viewer", "file", "view")).toBe(true);
    expect(can("viewer", "plan", "propose")).toBe(true);
    expect(can("viewer", "plan", "approve")).toBe(false);
    expect(can("viewer", "file", "organize")).toBe(false);
    expect(can("viewer", "file", "trash")).toBe(false);
  });

  it("editors organize and approve, but don't administer", () => {
    expect(can("editor", "plan", "approve")).toBe(true);
    expect(can("editor", "member", "create")).toBe(false);
    expect(can("editor", "settings", "manage")).toBe(false);
  });

  it("every grant is a declared statement and there is no file delete", () => {
    for (const grants of Object.values(ROLE_GRANTS))
      for (const [resource, actions] of Object.entries(grants)) {
        const declared = STATEMENTS[resource as keyof typeof STATEMENTS] as readonly string[];
        for (const a of actions as readonly string[]) expect(declared).toContain(a);
      }
    expect(STATEMENTS.file as readonly string[]).not.toContain("delete");
  });

  it("isRole guards strings", () => {
    expect(isRole("editor")).toBe(true);
    expect(isRole("member")).toBe(false);
  });
});
