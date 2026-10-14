import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createDeps } from "./deps";

const runtime = createDeps();
await runtime.start();
const { env, log } = runtime.deps;
const app = createApp(runtime.deps);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => log.info(`FolderPilot API listening on http://localhost:${info.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    server.close(() => void runtime.stop().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
