import { describe, expect, it } from "vitest";
import { en } from "@/locales/en";
import { el } from "@/locales/el";

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const enKeys = flatten(en as unknown as Tree);
const elKeys = flatten(el as unknown as Tree);

describe("locales", () => {
  it("Greek has exactly the English keys", () => {
    expect([...elKeys.keys()].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys.keys()].filter((k) => !elKeys.has(k))).toEqual([]);
  });

  it("no translation is empty", () => {
    expect([...enKeys].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    expect([...elKeys].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it("keeps the same {{placeholders}} in both languages", () => {
    const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();
    const mismatched = [...enKeys].filter(([k, v]) => elKeys.has(k) && vars(v).join() !== vars(elKeys.get(k)!).join()).map(([k]) => k);
    expect(mismatched).toEqual([]);
  });

  it("Greek is actually translated (mostly Greek letters, not English copies)", () => {
    const copied = [...enKeys].filter(([k, v]) => v.length > 12 && elKeys.get(k) === v).map(([k]) => k);
    expect(copied.length).toBeLessThan(Math.max(5, enKeys.size * 0.05));
  });
});
