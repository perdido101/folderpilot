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
Sign in to your FolderPilot as the **first account you created** (the server admin), then open
**Admin → Google Drive setup** (also linked from **New → Connect a source → Set up Google Drive**). The page walks
you through Google Cloud with a button for each step, shows your exact addresses with **Copy** buttons, and you paste
the two keys there. FolderPilot checks them with Google before saving. Then: **New → Connect a source → Google Drive**.

You don't need to touch Render's environment for this. Prefer environment variables? Set `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` on the service instead; they take precedence. `FP_ADMIN_EMAILS` (comma-separated) chooses who
may change server-wide settings, instead of the first account.

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
