import { defineConfig } from "tsup";

// Bundle workspace packages (they ship TypeScript source); keep npm deps external.
export default defineConfig({ entry: ["src/index.ts"], format: "esm", target: "node22", platform: "node", noExternal: [/^@folderpilot\//], clean: true,
  // Bundled CommonJS dependencies may call require() (e.g. for Node built-ins); give ESM output a real one.
  banner: { js: "import { createRequire as __fpCreateRequire } from 'node:module'; const require = __fpCreateRequire(import.meta.url);" },
});
