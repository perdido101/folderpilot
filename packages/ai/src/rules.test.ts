import { describe, expect, it } from "vitest";
import { proposeStructuredRule, RuleProposalError } from "./rules";
import type { AIProvider, ChatEvent } from "./types";

function replying(content: string): AIProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    label: "fake",
    cacheKey: "fake:1",
    describeImage: () => Promise.reject(new Error("unused")),
    describeText: () => Promise.reject(new Error("unused")),
    async *chat(system: string) {
      prompts.push(system);
      yield { type: "done", content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } satisfies ChatEvent;
    },
    test: () => Promise.resolve("ok"),
  };
}

describe("proposeStructuredRule", () => {
  it("returns a validated rule, stripping unknown fields", async () => {
    const p = replying(
      "```json\n" +
        JSON.stringify({
          name: "Screenshots to Temp",
          match: "all",
          conditions: [{ field: "flag", op: "has", value: "screenshot", extra: 1 }],
          actions: [{ type: "move", value: "Temp" }],
          bogus: true,
        }) +
        "\n```",
    );
    const rule = await proposeStructuredRule(p, "screenshots go to /Temp", ["Invoices"]);
    expect(rule).toEqual({ name: "Screenshots to Temp", match: "all", conditions: [{ field: "flag", op: "has", value: "screenshot" }], actions: [{ type: "move", value: "Temp" }] });
    expect(p.prompts[0]).toContain("Existing categories: Invoices");
    expect(p.prompts[0]).toContain("Never delete");
  });

  it("rejects ops that don't fit the field, unsafe regexes, delete actions and non-JSON", async () => {
    await expect(proposeStructuredRule(replying(JSON.stringify({ name: "x", conditions: [{ field: "size", op: "contains", value: "1" }], actions: [{ type: "tag", value: "t" }] })), "x")).rejects.toThrow(/doesn't work with size/);
    await expect(proposeStructuredRule(replying(JSON.stringify({ name: "x", conditions: [{ field: "name", op: "matches", value: "(a+)+" }], actions: [{ type: "tag", value: "t" }] })), "x")).rejects.toThrow(/Nested/);
    await expect(proposeStructuredRule(replying(JSON.stringify({ name: "x", conditions: [{ field: "ext", op: "is", value: "tmp" }], actions: [{ type: "delete", value: "" }] })), "x")).rejects.toThrow(RuleProposalError);
    await expect(proposeStructuredRule(replying("Sorry, no idea."), "x")).rejects.toThrow(/didn't return a rule/);
  });

  it("passes the AI's own explanation when the rule can't be expressed", async () => {
    await expect(proposeStructuredRule(replying('{"error": "Rules can\'t send email."}'), "email me")).rejects.toThrow("Rules can't send email.");
  });
});
