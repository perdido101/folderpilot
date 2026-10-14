import { describe, expect, it } from "vitest";
import { en } from "@/locales/en";

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

describe("locales", () => {
  it("no string is empty", () => {
    expect([...enKeys].filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
  });

  it("plural keys come in _one/_other pairs", () => {
    const keys = [...enKeys.keys()];
    const unpaired = keys.filter((k) => k.endsWith("_one") && !enKeys.has(k.replace(/_one$/, "_other")));
    expect(unpaired).toEqual([]);
  });
});
