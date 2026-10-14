/**
 * E2E helper services: a mock OpenAI-compatible AI (deterministic insights) and the real worker.
 * "unclear" text gets low confidence, so it lands in Needs Review.
 */
import { spawn } from "node:child_process";
import http from "node:http";

const port = Number(process.env.MOCK_AI_PORT ?? 3199);

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
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
server.listen(port, "127.0.0.1", () => console.log(`mock AI on ${port}`));

const worker = spawn("pnpm", ["--filter", "@folderpilot/worker", "exec", "tsx", "src/index.ts"], { cwd: "..", stdio: "inherit", env: process.env });
const stop = () => {
  worker.kill("SIGTERM");
  server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
worker.on("exit", (code) => {
  console.error(`worker exited (${code})`);
  server.close();
  process.exit(code ?? 1);
});
