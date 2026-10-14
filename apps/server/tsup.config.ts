import { defineConfig } from "tsup";

// Bundle workspace packages (they ship TypeScript source); keep npm deps external.
export default defineConfig({ entry: ["src/index.ts", "src/seed.ts"], format: "esm", target: "node22", platform: "node", noExternal: [/^@folderpilot\//], clean: true });
