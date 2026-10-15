/**
 * Production entry point for single-container deployments (Dockerfile, render.yaml):
 * apply database migrations, then run the API (which also serves the web app) and the worker.
 * FP_ROLE=server or FP_ROLE=worker runs only one of them (for separate services).
 */
import { spawn, spawnSync } from "node:child_process";

const role = process.env.FP_ROLE ?? "all";
const run = (name, args) => {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    console.error(`${name} exited (${signal ?? code}); stopping.`);
    // One process down = the whole service restarts (the host brings it back).
    for (const c of children) if (c !== child) c.kill("SIGTERM");
    setTimeout(() => process.exit(code ?? 1), 5_000).unref();
  });
  return child;
};

if (role !== "worker") {
  const migrate = spawnSync("pnpm", ["--filter", "@folderpilot/db", "migrate"], { stdio: "inherit", env: process.env });
  if (migrate.status !== 0) {
    console.error("Database migrations failed.");
    process.exit(1);
  }
}

const children = [];
// The bundles from `pnpm build` (lighter than running TypeScript through tsx).
if (role === "all" || role === "server") children.push(run("server", ["apps/server/dist/index.js"]));
if (role === "all" || role === "worker") children.push(run("worker", ["apps/worker/dist/index.js"]));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const c of children) c.kill(signal);
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}
