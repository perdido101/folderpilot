# FolderPilot — Progress (spec v2)

The v1 single-user prototype (8 phases, live at https://perdido101.github.io/folderpilot/) has been migrated into the
v2 monorepo. Work follows the 14 build phases in `CLAUDE.md` §20, one at a time.

| # | Phase | Status |
|---|-------|--------|
| 1 | Monorepo + foundations (db, auth/orgs/roles, API, worker, web shell, i18n (English), dev services, CI) | ✅ done |
| 2 | Core engine: StorageAdapter, plan engine, audit, undo, trash/restore, conflict checks; `local-browser` adapter | ✅ done |
| 3 | Analysis + AI: analysis package (browser + worker), BullMQ jobs, four AI providers, insight pipeline, Needs Review, Duplicates & Bad Files | ⏭ next |
| 4–14 | see `CLAUDE.md` §20 | — |

## Phase 2 — done

One engine for every mode now lives in `packages/core`; the browser ("This device") runs on it.

- **StorageAdapter** (`packages/core/src/storage/types.ts`): the §4 interface plus `resolve(path)`; `move` can rename in the same call;
  `trash`/`restore` return the entry. Errors: `ConflictError`, `NotFoundError`, `ReadOnlyError`. No delete anywhere (type-level test).
- **Engine** (`packages/core/src/engine/engine.ts`) — the only path that changes files:
  - Plans: create → edit (keep steps) → approve (needs `plan:approve` + per-step permission) → execute; statuses
    pending / approved / executing / executed / partially_failed / cancelled; per-step pending / done / failed / conflicted / skipped.
  - **Only people trash or restore**: rejected for agent, rule and MCP plans at create, approve and execute.
  - **Conflicts**: each file's first storage step pins the version it was planned against; a changed or missing file marks the step
    *conflicted* and nothing is touched. The person chooses **Skip** or **Apply to the current file**. Moves never overwrite (" (2)").
  - **Resumable**: index change + audit event + step status are written in one transaction; a re-run skips done steps and recognises
    a move that reached storage before a crash.
  - **Undo = inverse plan**, newest first: one event, one batch, or "everything the agent did since …". Undo events are new rows with
    `undoesEventId` (append-only); undo refuses to overwrite anything changed since; undo of an undo is refused; the agent can propose an
    undo (pending) but not one that trashes/restores.
  - **Trash** bookkeeping: original path, trashed by, kept until (30 days default). `canAutoRun()` helper for phases 4–5.
- **`local-browser` adapter** (`apps/web/src/lib/storage/local-browser.ts`): File System Access API, version = size-lastModified,
  native `move()` or copy → verify → remove, trash = `.folderpilot-trash/<path>`; read-only folders refuse every write.
- **Web wiring**: IndexedDB schema v3 (step statuses, undo events, trash table; old data upgraded), `dexie-store.ts`, and
  `lib/actions/engine.ts` as a thin wrapper. UI: Plan Cards show progress and conflicts (Skip / Apply to the current file),
  Audit Log has **Undo agent changes** (last hour / 24 hours / 7 days) and derives "undone" from undo events, Trash shows
  "kept at least until …".
- **Postgres store** (`packages/db/src/engine-store.ts`, migration `0003_engine`): the same engine on the server, through `scoped()`.
  Used by Cloud/Connect/Private server spaces from phase 7; no plan API routes yet.
- **English only**: the agent always replies in English; CLAUDE.md updated so later phases don't add Greek.

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
  - **i18n**: every string in `apps/web/src/locales/en/*.json` (one file per feature), typed keys. English only for now
    (Greek deferred at your request; adding it back is a new `locales/el/` folder, no component changes).
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, unit tests, integration tests (Postgres + Redis services), build.
  Pages workflow now builds `apps/web` in device-only mode.

## Verified (after phase 2)

- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm build` ✅
- `pnpm test` — 174 unit tests: core 81 (engine: lifecycle, permissions, human-only trash, conflicts, resume, undo, auto-run;
  rules, permissions, file kinds), web 47 (local-browser adapter, Dexie store + engine incl. conflicts/undo/read-only, v2 → v3 upgrade,
  `moveFile`, search, locales), analysis 21, ai 12, server 11, worker 2.
- `pnpm test:integration` (real Postgres + Redis) — db 12 (migrations, append-only trigger, undo link + view, pgvector, `scoped()`
  isolation; engine store: plan execution, undo events + `undone_by` view, trash history, transaction rollback, org isolation), server 9 (health, security headers, sign-up → org → owner role, invited viewer gets viewer permissions only, non-members get 404,
  features off when unconfigured, cross-site POST rejected), worker 1 (heartbeat job). Booting with only Postgres + Redis is a unit test.
- `pnpm test:e2e` (Playwright, Chromium) — 5 tests: sign up → org → shell → invite → dark theme → sign out; device mode opens a folder;
  move 3 files → Undo → back on disk (audit keeps both); trash → `.folderpilot-trash` → restore; file edited while a plan waits →
  conflict shown, nothing overwritten → "Apply to the current file".
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
- Trash is never purged automatically yet (that would permanently remove files); auto-purge after retention comes with admin settings (phase 11).
- The browser can't watch folders: changes made outside FolderPilot are picked up by Rescan, and show up as conflicts if a plan touches them.
- Plans made before this update that were waiting as agent "undo" proposals were cancelled by the upgrade; ask the agent again.
- "Accept AI suggestion" in Needs Review still sets the status directly (index-only, not a file change); it moves onto the engine in phase 3.
- `pnpm setup` is a built-in pnpm command, so the env script is `pnpm setup:env`.
- Docker Hub may rate-limit image pulls (429); `docs/SETUP.md` → Troubleshooting has the mirror workaround.
- English only (UI and agent), by decision.
- The repo isn't fully Prettier-formatted yet, so CI doesn't run a format check.
