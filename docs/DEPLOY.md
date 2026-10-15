# Deploy FolderPilot online

FolderPilot runs as **one container** (`Dockerfile`): it applies database migrations, then starts the API (which
also serves the web app from the same address) and the background worker (`scripts/start.mjs`). It needs
PostgreSQL 16 with the `vector` and `unaccent` extensions, and Redis (or a Redis-compatible store with
`maxmemory-policy noeviction`).

## Render (one click) — recommended for trying it

1. Sign in at <https://dashboard.render.com> (a GitHub login works) and allow Render to see the `folderpilot`
   repository if it asks.
2. Open **<https://render.com/deploy?repo=https://github.com/perdido101/folderpilot>** (or **New → Blueprint** and
   pick the repository). Render reads `render.yaml` and shows three resources: the `folderpilot` web service,
   `folderpilot-db` (Postgres) and `folderpilot-redis` (Key Value).
3. It asks for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ANTHROPIC_API_KEY`. **Leave them empty for now**
   (you need your site's address for Google first) → **Deploy Blueprint**.
4. The first build takes about 5–10 minutes. Your address appears at the top of the service page, e.g.
   `https://folderpilot-ab12.onrender.com`. Open it, **Create account**, then create your organization.

### Connect your Google Drive online
1. Do `docs/SETUP.md` §2 steps 1–3 (Google Cloud project, Drive API, consent screen in Testing with yourself as test user).
2. In your OAuth client (step 4 there) add, with **your** Render address:
   - Authorized JavaScript origin: `https://folderpilot-ab12.onrender.com`
   - Authorized redirect URIs:
     - `https://folderpilot-ab12.onrender.com/api/auth/callback/google`
     - `https://folderpilot-ab12.onrender.com/api/connect/gdrive/callback`
3. Render → `folderpilot` service → **Environment** → set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` → **Save,
   rebuild and deploy** (a restart is enough: **Save and deploy**).
4. In FolderPilot: **New → Connect a source → Google Drive**.

### AI online
- Easiest: set `ANTHROPIC_API_KEY` in the service's Environment (FolderPilot AI for everyone), or
- per organization in **Settings → AI for your organization** (your Claude API key, an OpenAI-compatible endpoint…).
  A local Ollama on your own computer can't be reached from Render.

### Free plan limits (Render)
- The free web service **sleeps after 15 minutes** without visits; the next visit takes about a minute to wake it,
  and Drive syncing pauses while it sleeps. Choose **Starter** (or higher) in the service's settings to keep it awake.
- 512 MB memory: fine for trying with a few hundred files. For larger Drives use Standard (2 GB).
- The free Postgres database **expires after 30 days**; upgrade it to keep your data. Free Key Value isn't
  persistent (only queued jobs are lost on restart; FolderPilot re-queues what's missing).

## Any other host (Docker)
```bash
docker build -t folderpilot .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://… -e REDIS_URL=redis://… \
  -e APP_URL=https://files.example.com -e API_URL=https://files.example.com \
  -e BETTER_AUTH_SECRET=$(openssl rand -base64 32) -e ENCRYPTION_KEY=$(openssl rand -base64 32) \
  folderpilot
```
- Put HTTPS in front (sign-in cookies are `Secure` in production).
- `APP_URL` and `API_URL` are your public address (same value). On Render they're filled in automatically from
  `RENDER_EXTERNAL_URL`.
- `FP_ROLE=server` or `FP_ROLE=worker` runs only one part, to scale them as separate services (same environment).
- Every other variable is optional and documented in `.env.example`.
