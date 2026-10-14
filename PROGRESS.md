# FolderPilot — Progress (spec v2)

The v1 single-user prototype (8 phases, live at https://perdido101.github.io/folderpilot/) has been migrated into the
v2 monorepo. Work follows the 14 build phases in `CLAUDE.md` §20, one at a time.

| # | Phase | Status |
|---|-------|--------|
| 1 | Monorepo + foundations (db, auth/orgs/roles, API, worker, web shell, i18n EN/EL, dev services, CI) | ✅ done |
| 2 | Core engine: StorageAdapter, plan engine, audit, undo, trash/restore, conflict checks; `local-browser` adapter | ⏭ next |
| 3–14 | see `CLAUDE.md` §20 | — |

## Phase 1 — done

**Workspace**: pnpm 10 workspaces + Turborepo, TypeScript strict (`noUncheckedIndexedAccess`), ESLint flat config (no `any`), Prettier.
Internal packages export TypeScript source; apps bundle them (Vite for web, tsup for server/worker).

```
apps/web        React SPA — account shell + the migrated prototype as "This device" (Private, browser-only)
apps/server     Hono API — Better Auth, orgs/roles, health, features, org-scoped routes
apps/worker     BullMQ worker — queue registry, heartbeat job, graceful shutdown
packages/core   domain types, roles + permissions, rules engine, file kinds, naming
packages/ai     AIProvider interface, zod JSON parsing, prompts, Ollama / OpenAI-compatible / Anthropic
packages/analysis  dHash, sharpness, brightness, screenshot heuristic, duplicate grouping
packages/ui     shadcn primitives, Clean Ledger tokens (light/dark), Tailwind preset
packages/db     Drizzle schema + SQL migrations (Postgres 16 + pgvector), scoped() data access, test DB helper
deploy/docker-compose.dev.yml   Postgres (pgvector) + Redis
e2e/            Playwright smoke tests
```

- **Database** (`packages/db`): Better Auth tables (`users`, `sessions`, `accounts`, `verifications`, `organizations`,
  `memberships`, `invitations`) + all §6 domain tables (`spaces`, `files` with `embedding vector(1024)`, `versions`, `rules`,
  `plans`, `plan_steps`, `audit_events`, `trash_items`, `shares`, `api_keys`, `ai_usage`, `subscriptions`, `notifications`),
  each with `organization_id` and indexes.
  - `audit_events` is **append-only at the database level** (trigger rejects UPDATE/DELETE/TRUNCATE). Undo is a new event
    with `undoes_event_id`; the view `audit_events_with_undo` exposes `undone_by`.
  - `scoped(db, orgId)` — every query is filtered by organization; inserts force `organization_id`, updates can't change it.
- **Auth** (Better Auth): email + password, Google/Microsoft only when configured, organizations with roles
  owner / admin / editor / viewer (permission table in `packages/core/src/permissions.ts`), invitations (link logged to the server log).
- **API**: `/api/health` (db + redis), `/api/config/features` (what's configured), `/api/me`, `/api/orgs/:id/spaces`,
  `/api/orgs/:id/members`. Security headers, CORS limited to `APP_URL`, origin check on every non-GET request (CSRF),
  Redis rate limit with in-memory fallback, pino logs (no file contents), AES-256-GCM helper for secrets at rest.
  Non-members get 404 for another org's routes.
- **Worker**: BullMQ queues from the core registry; a heartbeat job proves the pipeline. Real jobs arrive in phase 3.
- **Web**: sign in / sign up / create organization / accept invitation, org switcher, members admin page,
  §16 layout (sidebar with New ▾, Spaces, Needs Review, Recent, Categories, Duplicates & Bad Files, Rules, Pending Approvals,
  Audit Log, Shared, Trash, Settings/Admin; top bar with search, AI pill, notifications, theme, language, account; right
  Agent/Details panel). Items whose backend arrives later show an honest "Available in phase N" state.
  - **"Use on this computer without an account"** keeps the full prototype working locally (folder drop, analysis, AI, rules,
    agent, plans, undo, trash). The GitHub Pages build is this mode only (`VITE_LOCAL_ONLY=1`).
  - **i18n**: every string in `apps/web/src/locales/{en,el}/*.json` (one file per feature), typed keys, Greek translation,
    language switcher. Plans/audit text are written in the active UI language; prompts sent to the AI stay in English.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, unit tests, integration tests (Postgres + Redis services), build.
  Pages workflow now builds `apps/web` in device-only mode.

## Verified

- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm build` ✅
- `pnpm test` — 121 unit tests: core 46 (rules, permissions, file kinds), analysis 21 (dHash/duplicates), ai 12 (JSON parsing),
  web 29 (locale parity EN↔EL + placeholders, `moveFile`, local engine/undo, search), server 11 (env, crypto, rate limit), worker 2.
- `pnpm test:integration` (real Postgres + Redis) — db 7 (migrations, append-only trigger, undo link + view, pgvector round-trip,
  `scoped()` isolation), server 9 (health, security headers, sign-up → org → owner role, invited viewer gets viewer permissions only, non-members get 404,
  features off when unconfigured, cross-site POST rejected), worker 1 (heartbeat job). Booting with only Postgres + Redis is a unit test.
- `pnpm test:e2e` (Playwright, Chromium) — 2 smoke tests: sign up → create org → shell → invite member → Greek → dark theme → sign out;
  device mode opens a folder without an account.
- `pnpm services:up && pnpm db:migrate && pnpm db:seed && pnpm dev` — web :5173, API :3000 (health ok), worker heartbeat logged.

## What you need to configure

1. `pnpm install && pnpm setup:env` — creates `.env` with fresh secrets (never overwrites an existing one).
2. Docker running → `pnpm services:up` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.
3. Optional now: Google / Microsoft sign-in keys → `docs/SETUP.md` §2–3. Everything else (Drive, OneDrive, Dropbox, S3, Anthropic,
   Stripe, ClamAV) is documented there with the phase that starts using it; all of it stays hidden until configured.
4. GitHub → Settings → General → **Default branch** → `main` (can't be changed from here).

## Known issues / notes

- Emails (verification, invitations) are written to the server log, not sent — a mail provider comes with notifications.
- Google/Microsoft login is wired but not verified here (needs your OAuth credentials).
- "This device" mode still uses the prototype's browser engine (Dexie); phase 2 moves it onto the shared StorageAdapter + core engine.
- `pnpm setup` is a built-in pnpm command, so the env script is `pnpm setup:env`.
- Docker Hub may rate-limit image pulls (429); `docs/SETUP.md` → Troubleshooting has the mirror workaround.
- The repo isn't fully Prettier-formatted yet, so CI doesn't run a format check.
