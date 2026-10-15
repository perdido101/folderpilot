/**
 * E2E helper services: a mock OpenAI-compatible AI (deterministic insights) and the real worker.
 * "unclear" text gets low confidence, so it lands in Needs Review.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { MockGoogle } from "@folderpilot/adapters/testing";

const port = Number(process.env.MOCK_AI_PORT ?? 3199);

const server = http.createServer((req, res) => {
  // The browser calls the mock directly for folders on this device.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  // Test hook: where the mock Drive's files are now (paths from My Drive, trashed ones marked).
  if (req.url === "/gdrive/files") {
    const list = [...google.files.values()].filter((f) => f.id !== "root-id").map((f) => `${google.pathOf(f.id)}${f.trashed ? " (trashed)" : ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: list.sort(), revoked: google.revoked.length }));
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    if (req.url?.endsWith("/embeddings")) {
      // Deterministic "meaning": words mapped to a few concepts ("bill" ≈ "invoice", "holiday" ≈ "beach").
      const concepts: Record<string, number> = { bill: 1, invoice: 1, invoices: 1, receipt: 1, beach: 2, holiday: 2, photo: 2, photos: 2, note: 3, notes: 3, scribbles: 3 };
      const input = (JSON.parse(body || "{}") as { input: string[] }).input;
      const data = input.map((text, index) => {
        const v = new Array<number>(8).fill(0.001);
        for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (concepts[w]) v[concepts[w]!]! += 1;
        return { index, embedding: v };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-embed", data }));
      return;
    }
    const parsed = JSON.parse(body || "{}") as { stream?: boolean; tools?: unknown[]; messages?: { role: string; content?: string | null; name?: string }[] };
    if (parsed.stream && parsed.tools?.length) {
      agentTurn(res, parsed.messages ?? []);
      return;
    }
    const unclear = body.includes("unclear");
    const insight = {
      category: unclear ? "Notes" : body.includes("INVOICE") ? "Invoices" : "Photos",
      tags: ["e2e"],
      caption: unclear ? "Some handwritten notes." : "A test file.",
      suggestedName: "",
      entities: { client: body.includes("Alpha") ? "Alpha Ltd" : null, date: null, amount: null, docType: null },
      confidence: unclear ? 0.3 : 0.92,
      reason: unclear ? "Hard to tell what this is." : "Clear content.",
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "mock-e2e", choices: [{ message: { content: JSON.stringify(insight) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
/**
 * Scripted agent (OpenAI-compatible streaming with tool calls):
 * "tag the invoice as paid" → search_files → propose_plan (tag "paid") → "waiting for approval";
 * anything else → a short streamed text reply.
 */
function agentTurn(res: http.ServerResponse, messages: { role: string; content?: string | null }[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ model: "mock-e2e", choices: [{ delta }] })}\n\n`);
  const finish = () => {
    res.write(`data: ${JSON.stringify({ model: "mock-e2e", choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  const toolCall = (name: string, args: unknown) => send({ tool_calls: [{ index: 0, id: `call_${name}_${Date.now()}`, function: { name, arguments: JSON.stringify(args) } }] });
  const text = (t: string) => {
    for (const w of t.split(/(?<= )/)) send({ content: w });
  };
  const last = messages.at(-1);
  const userText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (last?.role === "tool") {
    const result = JSON.parse(last.content ?? "{}") as { files?: { id: string | number; name: string }[]; planId?: unknown; error?: string };
    if (result.files?.length) {
      const invoice = result.files.find((f) => /invoice/i.test(f.name)) ?? result.files[0]!;
      toolCall("propose_plan", { summary: "Tag the invoice as paid", reason: "You asked to mark it paid", steps: [{ fileId: invoice.id, action: "tag", to: "paid" }] });
    } else if (result.planId) text("I've prepared a plan to tag the invoice as paid. It's waiting for your approval.");
    else text(`I couldn't do that: ${result.error ?? "nothing matched"}.`);
  } else if (/tag .*invoice/i.test(userText ?? "")) {
    toolCall("search_files", { query: "invoice" });
  } else {
    text("Hello from the mock agent. Ask me to tag the invoice as paid.");
  }
  finish();
}

// A small Drive: "Clients" is the folder the e2e test connects.
const google = new MockGoogle();
const clients = google.addFolder("Clients");
google.addFolder("Personal");
google.addFile("invoice-77.md", "INVOICE 77 — Alpha Ltd — EUR 300", clients);
google.addFile("meeting.md", "Meeting notes for Alpha", clients);
await google.start(Number(process.env.MOCK_GOOGLE_PORT ?? 3198));

server.listen(port, "127.0.0.1", () => console.log(`mock AI on ${port}, mock Google on ${google.base}`));

const worker = process.env.E2E_USE_DIST
  ? spawn(process.execPath, ["apps/worker/dist/index.js"], { cwd: "..", stdio: "inherit", env: process.env })
  : spawn("pnpm", ["--filter", "@folderpilot/worker", "exec", "tsx", "src/index.ts"], { cwd: "..", stdio: "inherit", env: process.env });
const stop = () => {
  worker.kill("SIGTERM");
  server.close();
  void google.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
worker.on("exit", (code) => {
  console.error(`worker exited (${code})`);
  server.close();
  process.exit(code ?? 1);
});
