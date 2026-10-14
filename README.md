# FolderPilot

Organize, find and clean messy files on your own computer — a local-first PWA for small offices.
Drag a folder in from Windows Explorer; FolderPilot indexes it, finds duplicates and bad photos,
categorizes and names files with the AI you choose, and lets you ask an agent in plain language.
Nothing changes on disk until you approve a plan, every change is logged and undoable, and nothing is ever permanently deleted.

See `CLAUDE.md` for the product spec and `PROGRESS.md` for status.

```bash
pnpm install
pnpm setup:env      # create .env with fresh secrets
pnpm services:up    # Postgres + Redis (Docker)
pnpm db:migrate && pnpm db:seed
pnpm dev            # web http://localhost:5173 · API :3000 · worker
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build
pnpm test:e2e       # Playwright smoke tests
pnpm sample         # generate ./sample-messy (500+ messy test files)
```

Sign in with `owner@folderpilot.local` / `folderpilot-demo`, or choose **“Use on this computer without an account”**.
External accounts (Google, Microsoft, Dropbox, S3, Anthropic, Stripe…) are optional — see `docs/SETUP.md`.

AI is optional. In **Settings** pick Local (Ollama), an OpenAI-compatible endpoint, or Anthropic, then click **Test connection**.

**Live:** https://perdido101.github.io/folderpilot/ — redeployed by `.github/workflows/pages.yml` on every push to `main`
(device-only build with `VITE_LOCAL_ONLY=1`, `BASE_PATH=/folderpilot/` and publishes `apps/web/dist/` to the `gh-pages` branch).
