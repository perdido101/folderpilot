# FolderPilot — Setup guide

This guide gets FolderPilot running locally and walks you through connecting every external account, one at a time.
**Nothing here is required to start**: with only Postgres and Redis the app runs, and each integration stays hidden
(“not configured”) until you add its keys to `.env`. Restart `pnpm dev` after editing `.env`.

| Integration | Turns on | Needed from phase |
|---|---|---|
| [Google Cloud OAuth](#google) | “Continue with Google”, Google Drive (Connect mode) | sign-in now · Drive in phase 8 |
| [Microsoft Entra app](#microsoft) | “Continue with Microsoft”, OneDrive/SharePoint | sign-in now · OneDrive in phase 8 |
| [Dropbox app](#dropbox) | Dropbox (Connect mode) | phase 8 |
| [S3-compatible bucket](#storage) (R2 / B2 / Hetzner) | FolderPilot Cloud storage | phase 7 |
| [Anthropic API key](#anthropic) | “FolderPilot AI” (hosted default AI) | phase 3 ✅ |
| [Your organization's AI](#org-ai) (Claude API / Bedrock / Vertex / OpenAI-compatible / Ollama) | AI for server spaces | phase 3 ✅ |
| [Dev sample space](#sample) | Try the server pipeline locally | phase 3 ✅ |
| [Ollama](#ollama) | Local AI (Private mode) | phase 3 (browser mode works today via Settings) |
| [Stripe](#stripe) | Plans, checkout, billing portal | phase 11 |
| [ClamAV](#clamav) | Virus scanning of uploads (Cloud mode) | phase 7 |
| [Email delivery](#email) | Real invitation / verification / reset emails | see note |

---

## 1. Run it locally

Requirements: **Node 22+**, **pnpm 10** (`corepack enable`), **Docker** (for Postgres + Redis).

```bash
pnpm install
pnpm setup:env        # creates .env from .env.example with fresh secrets (never overwrites)
pnpm services:up      # Postgres 16 + pgvector and Redis 7 (deploy/docker-compose.dev.yml)
pnpm db:migrate       # create tables, pgvector, append-only audit trigger
pnpm db:seed          # demo org + 3 users (owner/editor/viewer), password: folderpilot-demo
pnpm dev              # web http://localhost:5173 · API http://localhost:3000 · worker
```

Sign in at http://localhost:5173 with `owner@folderpilot.local` / `folderpilot-demo` (also `editor@…`, `viewer@…`).
Or click **“Use on this computer without an account”** for Private mode in the browser (no server needed).

Checks: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build`.

> **Keep `ENCRYPTION_KEY` safe and stable.** It encrypts OAuth tokens and customer AI keys at rest (AES-256-GCM).
> If it changes, connected sources must be reconnected. In production, store it in your secret manager.

---

## <a id="google"></a>2. Google Cloud OAuth (sign-in + Google Drive)

1. Go to <https://console.cloud.google.com/> → create a project (e.g. “FolderPilot”).
2. **APIs & Services → Library**: enable **Google Drive API** (needed from phase 8; harmless now).
3. **APIs & Services → OAuth consent screen**:
   - User type **External** (or **Internal** for a Google Workspace org only).
   - App name “FolderPilot”, support email, your domain.
   - Scopes: `openid`, `email`, `profile`. Drive scopes are requested later, only when someone connects Drive
     (least privilege: `https://www.googleapis.com/auth/drive` is needed to move/rename files in place).
   - While “Testing”, add your own Google account under **Test users**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - Authorized JavaScript origins: `http://localhost:5173` (and your production web URL).
   - Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google` (and `https://<your-api>/api/auth/callback/google`).
5. Copy the values into `.env`:
   ```env
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
6. Restart `pnpm dev`. “Continue with Google” now appears on the sign-in page.

## <a id="microsoft"></a>3. Microsoft Entra ID app (sign-in + OneDrive/SharePoint)

1. Go to <https://entra.microsoft.com/> → **Identity → Applications → App registrations → New registration**.
2. Name “FolderPilot”. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   (multitenant + personal) — or single tenant if only your company uses it.
3. Redirect URI: platform **Web**, `http://localhost:3000/api/auth/callback/microsoft` (and your production API URL).
4. **Certificates & secrets → New client secret** → copy the **Value** (shown once).
5. **API permissions → Add → Microsoft Graph → Delegated**: `openid`, `email`, `profile`, `offline_access`, `User.Read`.
   For phase 8 add `Files.ReadWrite.All` and `Sites.ReadWrite.All` (SharePoint libraries); an admin may need to **Grant admin consent**.
6. `.env`:
   ```env
   MICROSOFT_CLIENT_ID=<Application (client) ID>
   MICROSOFT_CLIENT_SECRET=<secret value>
   MICROSOFT_TENANT=common        # or your Directory (tenant) ID for single-tenant
   ```

## <a id="dropbox"></a>4. Dropbox app

1. <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** → **Full Dropbox**.
2. **Permissions** tab: `files.metadata.read`, `files.metadata.write`, `files.content.read`, `files.content.write`, `account_info.read` → **Submit**.
3. **Settings** tab → Redirect URIs: `http://localhost:3000/api/connect/dropbox/callback` (phase 8) and your production URL.
4. Webhooks (phase 8): `https://<your-api>/api/webhooks/dropbox` (Dropbox requires a public HTTPS URL; use a tunnel such as `cloudflared` for local tests).
5. `.env`: `DROPBOX_APP_KEY=…`, `DROPBOX_APP_SECRET=…`

## <a id="storage"></a>5. S3-compatible bucket (FolderPilot Cloud)

Any S3-compatible provider works. EU region recommended.

**Cloudflare R2**
1. Dashboard → **R2** → **Create bucket** (e.g. `folderpilot-eu`, location hint *Europe*).
2. **R2 → Manage R2 API tokens → Create API token** → permission **Object Read & Write**, scoped to that bucket.
3. `.env`:
   ```env
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_BUCKET=folderpilot-eu
   S3_ACCESS_KEY=<Access Key ID>
   S3_SECRET=<Secret Access Key>
   S3_REGION=auto
   ```

**Backblaze B2**: create a bucket (private) → **Application Keys → Add** (restricted to the bucket) →
`S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com` (use your bucket's endpoint), `S3_REGION=eu-central-003`.

**Hetzner Object Storage**: create a bucket → **Security → S3 credentials** → `S3_ENDPOINT=https://fsn1.your-objectstorage.com`, `S3_REGION=fsn1`.

Enable **object versioning** on the bucket (version history, phase 7) and keep the bucket **private** (shares are signed links).

## <a id="anthropic"></a>6. Anthropic API key (FolderPilot AI)

“FolderPilot AI” is the hosted default: Claude through **your server's** key. Organizations choose it in
**Settings → AI for your organization**; signed-in people can also choose it for folders on their device
(only ≤512px thumbnails or extracted text go through your API, never whole files).

1. <https://console.anthropic.com/> → **Settings → API keys → Create key** (workspace “FolderPilot”).
2. Set a monthly spend limit under **Limits**. FolderPilot also enforces a per-organization **monthly AI file budget**
   (default 1,000 files; admins change it in Settings). Identical content is described once (cached by SHA-256).
3. `.env`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   FP_AI_ANALYSIS_MODEL=claude-haiku-5-5   # small, fast model for file analysis
   FP_AI_AGENT_MODEL=claude-opus-5-5       # stronger model for the agent (phase 5)
   ```
4. Restart `pnpm dev` (the API and the worker both read it). Without the key, FolderPilot AI is simply not offered.

## <a id="org-ai"></a>6b. Your organization's own AI (server spaces)

Owners/admins: **Settings → AI for your organization**. Keys are stored AES-256-GCM encrypted (with `ENCRYPTION_KEY`)
and are never shown again — the field says “saved”; type to replace, or “Remove saved key”.

- **Claude API**: paste an Anthropic API key and a model (e.g. `claude-opus-5-5`).
- **Amazon Bedrock**: AWS console → **Bedrock → Model access** → enable the Claude models; create an IAM user/role
  with `bedrock:InvokeModel*` on them. Enter the **region** (e.g. `eu-central-1`) and either an access key pair or leave
  the keys empty to use the server's AWS credentials (environment / instance role). The model id is prefixed with
  `anthropic.` automatically.
- **Google Vertex AI**: Google Cloud console → enable **Vertex AI API** → **Model Garden** → enable Claude.
  Create a service account with **Vertex AI User**, download its JSON key and paste it (or leave it empty to use the
  server's application-default credentials). Enter the **project ID** and **region** (`global` recommended).
- **OpenAI-compatible** (OpenAI, Azure OpenAI, gateways, LM Studio, vLLM): base URL, key, model.
- **Ollama on the server**: the server-side URL (e.g. `http://localhost:11434`) and models.

Click **Test connection**. The usage meter shows this month's analyzed files against the budget.

## <a id="sample"></a>6c. Dev sample space (try the server pipeline now)

Server spaces (Cloud, Connect, self-hosted Private) arrive in phases 7–9. Until then, development builds can show a
**read-only** folder on your machine as a server space:

```bash
pnpm sample                                  # creates ./sample-messy (650 mixed files)
# .env:  FP_DEV_SAMPLE_DIR=/absolute/path/to/folderpilot/sample-messy
pnpm db:seed                                 # adds "Sample files (dev)" to Demo Office
pnpm dev                                     # API + web + worker
```

Sign in as `owner@folderpilot.local`, set an AI in **Settings → AI for your organization** (or skip it: local
analysis still finds duplicates and bad photos), click **Sample files (dev)** in the sidebar → **Scan & analyze**.
The worker hashes, measures and reads every file, flags duplicates/blurry/dark/tiny/screenshots, then asks the AI.
Low-confidence results land in **Needs Review**. Moving/renaming/trashing is refused on this space until phase 9.

## <a id="ollama"></a>7. Ollama (local AI)

1. Install from <https://ollama.com/download>.
2. Pull models:
   ```bash
   ollama pull llava:7b          # vision (photos, screenshots)
   ollama pull llama3.2:3b       # text + agent tools
   ollama pull nomic-embed-text  # embeddings for search by meaning
   ```
3. **Browser mode** (Private, single user): allow the web app's origin, then restart Ollama.
   - Windows: `setx OLLAMA_ORIGINS "http://localhost:5173"` (add your deployed URL too, comma-separated).
   - macOS: `launchctl setenv OLLAMA_ORIGINS "http://localhost:5173"`; Linux (systemd): add `Environment="OLLAMA_ORIGINS=..."` to the service.
   Then **Settings → AI provider → Local — Ollama → Test connection**.
4. **Server mode**: set `OLLAMA_URL=http://localhost:11434` (or `http://ollama:11434` inside docker-compose.selfhost, phase 9).

### <a id="embeddings"></a>7b. Search by meaning (embeddings)

Search always works by words. It also finds files by meaning ("bill" finds invoices) when an embedding model is
available. Which one is used, in order:

1. **The organization's own AI**, if it can make embeddings: *OpenAI-compatible* (uses its **Embedding model**, asked
   for 1024 dimensions — `text-embedding-3-small` / `-large` support that) or *Ollama* (its **Embedding model**).
2. **The server's Ollama**: when the organization uses FolderPilot AI or Claude/Bedrock/Vertex (they have no
   embeddings), set `OLLAMA_URL` and optionally `FP_EMBED_MODEL` in `.env` (default `nomic-embed-text`; good
   alternatives: `mxbai-embed-large`, `bge-m3`), then `ollama pull <model>` on that machine.
3. Neither: search uses words only, and the Search page says "words only — set up search by meaning".

Notes:
- FolderPilot stores 1024-dimensional vectors. Smaller models are padded (no quality loss); models with more than
  1024 dimensions that can't reduce them are refused with a clear message in the worker log.
- The worker embeds new and changed files in the background after analysis (and re-checks every 15 minutes). Changing
  the embedding model re-embeds files automatically; only vectors from the same model are compared.
- On **This device**, the folder's index updates after AI analysis when your device AI can embed (Settings →
  *Search by meaning* → *Rebuild index* forces a full rebuild).

## <a id="stripe"></a>8. Stripe (billing, phase 11)

1. <https://dashboard.stripe.com/test/apikeys> → copy the **Secret key** (`sk_test_…`) → `STRIPE_SECRET_KEY`.
2. **Products** → create one product per plan (Personal, Plus, Business per seat, Connect per seat) with a recurring price →
   copy each **price id** (`price_…`) into `STRIPE_PRICE_*`. Create a **metered** price for storage overage → `STRIPE_PRICE_STORAGE_OVERAGE`.
3. **Developers → Webhooks → Add endpoint** `https://<your-api>/api/webhooks/stripe`, events: `checkout.session.completed`,
   `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed` → copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`.
   Local testing: `stripe listen --forward-to localhost:3000/api/webhooks/stripe` prints a temporary signing secret.
4. **Settings → Billing → Customer portal**: enable plan switching and cancellation.

## <a id="clamav"></a>9. ClamAV (upload scanning, phase 7)

```bash
docker run -d --name clamav -p 3310:3310 clamav/clamav:stable   # first start downloads signatures (~5 min)
```
`.env`: `CLAMAV_HOST=localhost:3310`. Without it, Cloud uploads are accepted but marked “not scanned”.

## <a id="email"></a>10. Email delivery

Invitations, email verification and password resets currently **write their links to the server log**
(look for `invitation link` / `email verification link`). A mail provider (SMTP / Postmark / SES) is added together with
notifications; until then, copy links from the log during development.

## 11. Troubleshooting

- **“Can't reach the server”** in the web app → the API isn't running on :3000. Run `pnpm dev`, or use device mode.
- **`ECONNREFUSED 5432/6379`** → `pnpm services:up`. Check `docker compose -f deploy/docker-compose.dev.yml ps`.
- **Docker Hub rate limit (429) pulling images** → `docker pull mirror.gcr.io/pgvector/pgvector:pg16` and
  `docker tag mirror.gcr.io/pgvector/pgvector:pg16 pgvector/pgvector:pg16` (same for `library/redis:7-alpine` → `redis:7-alpine`).
- **Signed out after every restart** → set `BETTER_AUTH_SECRET` in `.env` (`pnpm setup:env` does it).
- **OAuth `redirect_uri_mismatch`** → the redirect URI must match exactly, including `http` vs `https` and port 3000.
