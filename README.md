# FolderPilot

Organize, find and clean messy files on your own computer — a local-first PWA for small offices.
Drag a folder in from Windows Explorer; FolderPilot indexes it, finds duplicates and bad photos,
categorizes and names files with the AI you choose, and lets you ask an agent in plain language.
Nothing changes on disk until you approve a plan, every change is logged and undoable, and nothing is ever permanently deleted.

See `CLAUDE.md` for the product spec and `PROGRESS.md` for status.

```bash
npm install
npm run dev        # http://localhost:5173 — open in Chrome or Edge
npm run build      # strict typecheck + production build (PWA)
npm test           # Vitest unit tests
npm run sample     # generate ./sample-messy (500+ messy test files); add -- <path> or --force
```

AI is optional. In **Settings** pick Local (Ollama), an OpenAI-compatible endpoint, or Anthropic, then click **Test connection**.
