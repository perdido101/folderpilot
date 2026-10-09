import { describe, expect, it } from "vitest";
import type { FileRecord } from "../db";
import { dryRun, matchesCondition, matchesRule, planAllRules, renderTemplate, stepsForFile } from "./evaluate";
import type { Rule } from "./types";

let id = 1;
const mtime = new Date(2024, 2, 15).getTime();
function file(p: Partial<FileRecord>): FileRecord {
  return { id: id++, rootId: 1, path: "Downloads/x.pdf", name: "x.pdf", ext: "pdf", kind: "document", size: 2_000_000, mtime, status: "analyzed", flags: [], tags: [], ...p };
}
function rule(p: Partial<Rule>): Rule {
  return { id: id++, type: "structured", name: "r", enabled: true, priority: 1, match: "all", conditions: [], actions: [], createdBy: "user", createdAt: 0, ...p };
}

describe("conditions", () => {
  const f = file({ path: "Clients/Alpha/Invoice 1001.pdf", name: "Invoice 1001.pdf", category: "Invoices", tags: ["paid"], flags: ["duplicate"], textExcerpt: "INVOICE Alpha Ltd total EUR 1,240" });
  it.each([
    [{ field: "ext", op: "is", value: "PDF, .docx" }, true],
    [{ field: "ext", op: "is_not", value: "pdf" }, false],
    [{ field: "kind", op: "is", value: "document" }, true],
    [{ field: "name", op: "contains", value: "invoice" }, true],
    [{ field: "name", op: "not_contains", value: "invoice" }, false],
    [{ field: "name", op: "starts_with", value: "inv" }, true],
    [{ field: "content", op: "contains", value: "alpha ltd" }, true],
    [{ field: "date", op: "after", value: "2024-01-01" }, true],
    [{ field: "date", op: "before", value: "2024-01-01" }, false],
    [{ field: "size", op: "gt", value: "1" }, true],
    [{ field: "size", op: "lt", value: "1" }, false],
    [{ field: "folder", op: "starts_with", value: "/Clients/" }, true],
    [{ field: "folder", op: "is", value: "Clients" }, false],
    [{ field: "category", op: "is", value: "invoices" }, true],
    [{ field: "flag", op: "has", value: "duplicate" }, true],
    [{ field: "tag", op: "has", value: "PAID" }, true],
  ] as const)("%o → %s", (c, expected) => expect(matchesCondition(f, { ...c })).toBe(expected));

  it("within_days uses the given clock", () => {
    expect(matchesCondition(file({ mtime: 0 }), { field: "date", op: "within_days", value: "7" }, 3 * 86_400_000)).toBe(true);
    expect(matchesCondition(file({ mtime: 0 }), { field: "date", op: "within_days", value: "7" }, 30 * 86_400_000)).toBe(false);
  });
});

describe("matchesRule", () => {
  const f = file({ name: "Screenshot 1.png", ext: "png", kind: "image" });
  const c1 = { field: "ext", op: "is", value: "png" } as const;
  const c2 = { field: "name", op: "contains", value: "invoice" } as const;
  it("all vs any", () => {
    expect(matchesRule(f, rule({ conditions: [c1, c2] }))).toBe(false);
    expect(matchesRule(f, rule({ match: "any", conditions: [c1, c2] }))).toBe(true);
  });
  it("never matches with no conditions or for natural rules", () => {
    expect(matchesRule(f, rule({ conditions: [] }))).toBe(false);
    expect(matchesRule(f, rule({ type: "natural", conditions: [c1] }))).toBe(false);
  });
});

describe("templates and steps", () => {
  const f = file({ name: "scan001.pdf", path: "Scans/scan001.pdf", category: "Invoices", client: "Alpha Ltd" });
  it("renders variables", () => {
    expect(renderTemplate("{category}/{client}/{year}-{month} {name}.{ext} ({type})", f)).toBe("Invoices/Alpha Ltd/2024-03 scan001.pdf (Documents)");
    expect(renderTemplate("{unknown}", f)).toBe("{unknown}");
  });

  it("move + rename become one path step; tag/caption/category/flag follow", () => {
    const r = rule({
      actions: [
        { type: "move", value: "Clients/{client}/{year}" },
        { type: "rename", value: "{date} {category}" },
        { type: "tag", value: "Invoice" },
        { type: "caption", value: "Invoice for {client}" },
        { type: "set_category", value: "Bills" },
        { type: "flag_review", value: "" },
      ],
    });
    const steps = stepsForFile(f, r);
    expect(steps.map((s) => s.action)).toEqual(["move", "tag", "caption", "category", "flag"]);
    expect(steps[0]).toMatchObject({ from: "Scans/scan001.pdf", to: "Clients/Alpha Ltd/2024/2024-03-15 Invoices.pdf", actor: `rule:${r.id}` });
    expect(steps[1]).toMatchObject({ to: "invoice" });
  });

  it("cleans unsafe folder names and skips no-op changes", () => {
    const r = rule({ actions: [{ type: "move", value: "../A:B/ ./C" }] });
    expect(stepsForFile(f, r)[0]!.to).toBe("AB/C/scan001.pdf");
    expect(stepsForFile(f, rule({ actions: [{ type: "move", value: "Scans" }] }))).toEqual([]);
    expect(stepsForFile(file({ tags: ["x"] }), rule({ actions: [{ type: "tag", value: "X" }] }))).toEqual([]);
  });

  it("uses rename when only the name changes", () => {
    expect(stepsForFile(f, rule({ actions: [{ type: "rename", value: "Invoice" }] }))[0]).toMatchObject({ action: "rename", to: "Scans/Invoice.pdf" });
  });
});

describe("dry run and combined plans", () => {
  const shot = file({ name: "Screenshot 1.png", path: "Desktop/Screenshot 1.png", ext: "png", kind: "image", flags: ["screenshot"] });
  const inv = file({ name: "inv.pdf", path: "Downloads/inv.pdf", category: "Invoices" });
  const trashed = file({ name: "old.png", ext: "png", status: "trashed", flags: ["screenshot"] });
  const screenshots = rule({ priority: 1, conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "move", value: "Temp" }, { type: "tag", value: "screenshot" }] });
  const images = rule({ priority: 2, conditions: [{ field: "kind", op: "is", value: "image" }], actions: [{ type: "move", value: "Pictures" }, { type: "tag", value: "image" }] });
  const disabled = rule({ enabled: false, conditions: [{ field: "ext", op: "is", value: "pdf" }], actions: [{ type: "move", value: "PDFs" }] });

  it("dry run lists matches and skips trashed files", () => {
    const res = dryRun([shot, inv, trashed], screenshots);
    expect(res.matches).toEqual([shot]);
    expect(res.steps.map((s) => s.to)).toEqual(["Temp/Screenshot 1.png", "screenshot"]);
  });

  it("first matching rule (by priority) decides the location; tags from all rules apply", () => {
    const steps = planAllRules([shot, inv], [images, disabled, screenshots]);
    expect(steps.filter((s) => s.action === "move").map((s) => s.to)).toEqual(["Temp/Screenshot 1.png"]);
    expect(steps.filter((s) => s.action === "tag").map((s) => s.to)).toEqual(["screenshot", "image"]);
  });
});
