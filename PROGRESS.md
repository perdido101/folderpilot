# FolderPilot — Progress (spec v2)

The v1 single-user prototype (8 phases, live at https://perdido101.github.io/folderpilot/) has been migrated into the
v2 monorepo. Work follows the 14 build phases in `CLAUDE.md` §20, one at a time.

| # | Phase | Status |
|---|-------|--------|
| 1 | Monorepo + foundations (db, auth/orgs/roles, API, worker, web shell, i18n (English), dev services, CI) | ✅ done |
| 2 | Core engine: StorageAdapter, plan engine, audit, undo, trash/restore, conflict checks; `local-browser` adapter | ✅ done |
| 3 | Analysis + AI: analysis package (browser + worker), BullMQ jobs, four AI providers, insight pipeline, Needs Review, Duplicates & Bad Files | ✅ done |
| 4 | Rules: structured builder UI, natural rules, dry-run, auto/suggest modes, triggers | ✅ done |
| 5 | Agent: tools, streaming chat, Plan Cards, Pending Approvals, command palette, mini mode | ✅ done |
| 6 | Search: full-text + pgvector hybrid, filters, search UI | ✅ done |
| 7 | Cloud mode: fp-cloud adapter, uploads, previews, versions, shares, quotas, ClamAV | ⏭ next |
| 8–14 | see `CLAUDE.md` §20 | — |

## Phase 6 — done

- **One query language everywhere** (`packages/core/src/search`). Natural queries become words plus filters, shown
  as removable chips:
  - "invoices from Alpha 2025 pdf" → words `invoices alpha` + year 2025 + `.pdf`;
  - kind words: photos, documents, spreadsheets…;
  - flag words: screenshots, duplicates, blurry, dark;
  - relative dates: today, yesterday, this/last week, month, year.

  Results are merged with **reciprocal-rank fusion**, which also reports whether each file was found by words, by
  meaning, or both.
- **Words: Postgres full-text** (migration 0007).
  - A trigger keeps a weighted `search_tsv` up to date (name/client > caption/category/tags/docType > folder path
    > extracted text).
  - It is accent-insensitive (`unaccent`, so "cafe" finds "Café") and language-neutral, with prefix matching while
    you type.
  - GIN index. Highlighted snippets from the caption or text.
- **Meaning: pgvector**, with an HNSW cosine index and filtered iterative scans.
  - Every vector records its model, and only vectors from the same model are compared, so changing the model
    re-embeds files.
  - Vectors are stored at 1024 dimensions: smaller models are zero-padded (cosine unchanged); larger ones are refused
    with a clear message. OpenAI-compatible endpoints are asked for 1024 dimensions, and asked again without it if
    they don't support that.
  - **Which model:** the org's AI if it can embed (OpenAI-compatible, Ollama), else the server's Ollama
    (`OLLAMA_URL` + new `FP_EMBED_MODEL`), else words only.
  - The worker's new `embeddings` job embeds new/changed files after analysis (skipping unchanged text), and the
    15-minute tick re-queues anything missing.
- **API:** `GET /api/orgs/:id/search` searches all of an organization's spaces (or one). Filters: type, extension,
  category, space, flag, client, date range. It returns facet counts for the filter menus and says whether meaning
  was used. The agent's `search_files` on server spaces now uses the same hybrid search.
- **Web: a new Search page.**
  - Typing in the top bar opens it.
  - Chips for recognized words, each with ×.
  - Filters with counts: type, modified, category, space, flag, client.
  - Results show the name, space or folder, path, date, category, a highlighted snippet and a "by meaning" badge.
  - "Show more" pages through results.
  - Opening a result: quick look on this device; the file in its space on servers.
  - The command palette gains "Search all files for …".
  - **This device** uses the same parser and RRF in the browser. Its meaning index now updates by itself after AI
    analysis when the device AI can embed (Settings keeps a "Rebuild index" button).
  - The All Files page no longer filters by the top-bar search: that lives on the Search page.

## Phase 5 — done

- **One agent, two runtimes.** `packages/ai/src/agent` holds the shared pieces:
  - the 11 spec tools: search_files, list_files, get_file, explain_categorization, propose_plan, propose_rule,
    update_rule_proposal, flag_for_deletion, propose_undo, get_audit(filter), stats(question);
  - **no delete, trash or approve tool** (asking for one gets "there is no delete tool");
  - the English-only system prompt (it tells the model whether the person can approve);
  - a streaming loop: text as it is written, a progress event per tool call, Plan Cards and file chips; at most
    8 rounds, a time budget, and tool results capped before they go back to the model.
  - **This device:** the loop runs in the browser with tools over the local index (`lib/agent/device-tools.ts`).
    Without an AI it still answers with a keyword search.
  - **Server spaces:** the loop runs on the server (`POST /api/orgs/:id/spaces/:spaceId/agent`, SSE) with tools over
    Postgres (`packages/db/src/agent/space-tools.ts`, ready for the phase 10 MCP server). Every query is scoped to the
    organization and the space, and every tool checks the person's role (viewers may look things up and propose
    plans but not rules; approving still needs an editor or admin). It uses the organization's AI and records usage.
    With no AI connected it says so.
- **Every change is a plan.** Agent plans are `source: agent`, actor `agent:<userId>` (`agent:local` on this
  device), and wait in Pending Approvals and in the chat.
  - `flag_for_deletion` is now a plan too: it only flags files for review; nothing is ever trashed.
  - Rule proposals are always Suggest, and the agent can't switch a rule to Auto.
  - `update_rule_proposal` revises a pending proposal (the old one is withdrawn) or proposes edits to an existing rule.
  - `propose_undo` undoes a batch, or everything the agent did since a time.
- **Auto-run for small plans (spec §2), off by default.** Admins can set "Agent auto-run limit (files)" in Settings →
  AI for your organization; on this device it's "Let the agent apply small plans by itself". Rule changes, trash
  and restore always need a person. Engine: `autoApproveSmall()`.
- **Every tool call is logged.** On the server, `agent_tool_calls` (migration 0006) records tool, short input summary
  (no file contents), ok/error and duration; on this device, the Dexie table `agentLog` (v4). Shown in a new
  **Audit Log → Agent activity** tab (admins see everyone's calls, others their own).
- **UI.**
  - The chat streams; each tool call shows as a line (spinner, then ✓ with "Found 3 files").
  - **Stop** button; "New conversation".
  - One conversation per folder or space, kept for the browser tab.
  - Plan Cards in the chat: device plans as before; server plans load by id with Approve (with Undo) / Edit (untick) /
    Cancel, or "Waiting for someone who can approve".
  - Works in the right panel, in **mini mode** (server spaces too, with last actions + Undo) and from the **command
    palette** ("Ask the agent: …").
  - `GET /api/orgs/:id/plans/:planId` (one plan) and an `ids` filter on the space files list support the chat.

## Phase 4 — done

- **Rule engine (`packages/core`).**
  - New conditions: name/content **matches regex** (case-insensitive; empty, over-long, nested-quantifier or invalid
    patterns never match and are flagged in the builder), **client** and **document type** (from AI entities),
    **space / folder** (the source). New template variable `{docType}`.
  - Every rule has a **mode** (Suggest = creates a plan for approval; Auto = applies by itself, still audited as
    `rule:<id>` and undoable), a **scope** (all spaces or one), a **schedule** (only new/changed files, hourly, daily,
    weekly) and can be **archived** (rules are never deleted; archive is an audited, undoable change).
  - `rulesForFiles()` groups what the rules would do per rule in spec order (priority, first matching move wins, tags
    add up); `ruleProblem()` is the one validator used by the builder, the API and AI proposals.
  - Engine `autoApprove()`: only plans from an enabled rule set to Auto may run without a person; trash/restore never
    qualify. `approvedBy` stays empty — no person approved it.
- **Plain-language → structured (`packages/ai`).** `proposeStructuredRule()` asks the configured AI for one rule as JSON
  and validates it (zod + `ruleProblem`); unknown fields are dropped, there's no delete action, and the AI can answer
  "can't be expressed" with a reason. The result opens in the builder as a proposal; nothing is saved automatically.
- **Server.**
  - Migration `0005`: rules get `scope_space_id`, `schedule`, `last_run_at`, `archived_at`; files get `rules_checked_at`.
  - `GET/POST/PUT/DELETE /api/orgs/:id/rules` — every change is a plan through the engine (audited, undoable;
    `…/rules/history`, `…/rules/undo`). **Only admins can make or change Auto rules** (anyone who manages rules may
    still pause or archive one). Viewers can read rules.
  - `POST …/rules/test` dry-run of a saved or unsaved rule (count + first steps, nothing changes),
    `POST …/rules/run` ("Run on folder": auto rules execute, suggest rules become pending plans; files already waiting
    in a pending plan of the same rule are skipped), `POST …/rules/convert` (organization AI).
  - Pending plans: `GET …/spaces/:id/plans?status=pending`, `POST …/plans/:id/approve | keep-steps | cancel`.
  - "Set category" in Needs Review returns a hint so the UI can offer **Make this a rule?**.
- **Worker triggers.** A per-space `rules` job (deduplicated) runs after a file's AI insight — or after local analysis
  when the org has no AI — over files the rules haven't seen since their last analysis. A **15-minute tick** runs due
  scheduled rules over their whole scope (records `last_run_at`) and re-queues spaces with unchecked files as a safety net.
- **Web (same UI for "This device" and server spaces).**
  - Rules page with mode/schedule/scope badges, reorder, Edit/Test, Run, Run all, archive; read-only for viewers.
  - Builder: new fields, live regex validation, Mode (Auto disabled with a note when your role can't pick it), Applies
    to, Also run (schedule), and a dry-run with the first 10 before → after changes.
  - Plain-language rules: add, pause, archive, **Convert to structured** (opens the builder pre-filled).
  - **Pending Approvals for server spaces** (Approve with Undo, Edit = untick steps, Cancel) + sidebar badge.
  - **Make this a rule?** after "Set category" on a server space (and still after drag-to-category on this device),
    pre-filled from the file's extension and AI document type or folder.
  - This device: auto rules run after a folder is indexed and analyzed, suggest rules wait in Pending Approvals,
    schedules run while the app is open (checked every minute). A toast summarizes what rules did, with "Review".

## Phase 3 — done

- **`packages/analysis` — one analyzer for browser and server.** `analyzeFile()` does SHA-256 (partial for files over
  256 MB), dHash, contrast-normalized blur, brightness, size, EXIF (exifr) and a text excerpt (TXT/CSV/…, DOCX with
  mammoth, PDF through an injected reader). Image decoding is injected: OffscreenCanvas in the browser worker, `sharp`
  in the server worker (pdf.js legacy build for PDFs). The browser's analysis worker is now a thin wrapper.
- **`packages/ai` — four providers, streaming, entities, usage.**
  - `FileInsight` now has `entities { client, date, amount, docType }`; strict zod validation; English only.
  - `chat()` streams (`AsyncIterable<ChatEvent>`: text deltas, then the full turn with tool calls and usage);
    `collectChat()` keeps today's agent working until phase 5. Every call returns token usage.
  - Providers: **FolderPilot AI** (our `ANTHROPIC_API_KEY`, `FP_AI_ANALYSIS_MODEL` for files, `FP_AI_AGENT_MODEL` for
    the agent), **Ollama**, **OpenAI-compatible**, **your Claude** on the Claude API, **Amazon Bedrock** or **Google
    Vertex AI** (server-only: `@folderpilot/ai/server`, official SDK clients, created lazily). Server-side refusal
    fallbacks are used on the Claude API for models that support them.
- **Organization AI (server).** New tables `org_settings` (provider + AES-256-GCM-encrypted secrets bound to the org,
  thresholds, monthly AI file budget — default 1,000) and `ai_insight_cache` (same content + same provider/model =
  no second call). Every call is recorded in `ai_usage`; at the budget, AI analysis stops with a clear message.
  Routes: `GET/PUT /api/orgs/:id/settings/ai` (admins; keys never returned), `…/settings/ai/test`, `…/ai/status`,
  `POST …/ai/describe` (FolderPilot AI for folders on this device: ≤512px thumbnails or text only, metered, cached)
  and `POST …/ai/chat` (SSE streaming, ready for the phase 5 agent).
- **Worker pipeline (BullMQ).** `index` (scan a space, upsert files, forget removed ones) → `analysis` per file →
  `flags` per space (deduplicated) → `ai` per file (rule-set category wins → natural rules in the prompt → AI;
  confidence < threshold → **Needs Review**). Retries with backoff, permanent failures (budget, missing space) don't
  retry, everything idempotent. Adapter registry in the new `packages/adapters`.
- **Dev sample space (your choice).** `LocalServerAdapter` (Node fs, path-traversal and symlink-escape safe) shipped
  **read-only**; `FP_DEV_SAMPLE_DIR` + `pnpm db:seed` adds "Sample files (dev)" to Demo Office. Never in production.
  It becomes the writable `local-server` adapter in phase 9.
- **Server space routes.** Files (filters: status, flag, category, search), status/progress, duplicate groups with a
  "keep best" pick, scan, review actions (accept / set category / keep / trash) **through the core engine with the
  Postgres store** (audited, undoable), the space's audit log (with "undone by"), and undo.
- **Web.**
  - Server spaces in the sidebar are clickable; All Files, Needs Review, Duplicates & Bad Files (with review mode
    ← trash / → keep) and Audit Log show the server space; other views say which phase brings them.
  - Header with live progress ("537 of 537 analyzed · 0 described by AI"), **Scan & analyze**, read-only notice.
  - **Settings → AI for your organization** (admins): provider (FolderPilot AI only when the server has a key; Claude
    API / Bedrock / Vertex; OpenAI-compatible; Ollama), write-only keys ("saved — type to replace", "Remove saved key"),
    budget + usage meter, Test connection. "AI for folders on this device" gains FolderPilot AI when signed in.
  - AI status pill shows the organization's AI while a server space is open.
  - **Accept** in Needs Review (device mode) now goes through the engine: audited and undoable.

Verified on the real 546-file `pnpm sample` folder via `pnpm dev`: 537 files indexed and analyzed by the worker in
~11 s; 70 exact-copy groups (84 copies), 6 burst near-duplicate groups (14 photos), 17 blurry, 10 dark, 15 tiny,
81 screenshots. (No AI key here, so AI ran only against mocks.)

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

## Verified (after phase 6)

- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm build` ✅
- `pnpm test` — 241 unit tests:
  - core 98 (adds query parsing incl. relative dates, chip removal, RRF, padding keeps cosine, oversized vectors
    refused, embed-text hash);
  - ai 41 (adds the OpenAI `dimensions` request and its retry, and the embedder fallback order with padding);
  - web 62 (device hybrid search with RRF and sources, incremental index build);
  - analysis 27, adapters 4, server 11, worker 2.
- `pnpm test:integration` (real Postgres + Redis + pgvector):
  - db 23 (adds the trigger keeping `search_tsv` current, ranking name > text, accents, prefix, trashed and other orgs
    excluded, snippets, every filter, facets, meaning with fake vectors, same-model only, "both" ranks first,
    query-vector cache, fallback to words when the model fails, GIN/HNSW index use in EXPLAIN);
  - server 40 (adds the search API: all spaces, chips, facets, filters, meaning on/off/unavailable, the agent's
    hybrid `search_files`, 404/400 scoping);
  - worker 11 (adds the embeddings job: padded vectors, unchanged text skipped, edited text and new model re-embed,
    the server-Ollama fallback, no model → no-op).
- `pnpm test:e2e` — 13 tests, adding:
  - **server:** "alpha invoice" → invoice first with highlighted match → "bill" found by meaning → "photos" chip →
    remove it → Type and Category filters → open the result in its space;
  - **this device:** "invoice this year" → date chip, results → remove the chip → Type filter.
- `pnpm dev` on the 537-file sample: searches answer in 40–125 ms (words; no embedding model is set up here).

## What you need to configure

1. `pnpm install && pnpm setup:env` — creates `.env` with fresh secrets (never overwrites an existing one).
2. Docker running → `pnpm services:up` → `pnpm db:migrate` → `pnpm db:seed` → `pnpm dev`.
3. To try the server pipeline: `pnpm sample`, set `FP_DEV_SAMPLE_DIR=/absolute/path/to/sample-messy` in `.env`,
   `pnpm db:migrate && pnpm db:seed`, `pnpm dev` (docs/SETUP.md §6c). For AI: `ANTHROPIC_API_KEY` (FolderPilot AI),
   or your own Claude/Bedrock/Vertex/OpenAI-compatible/Ollama in **Settings → AI for your organization** (§6, §6b).
4. Optional now: Google / Microsoft sign-in keys → `docs/SETUP.md` §2–3. Everything else (Drive, OneDrive, Dropbox, S3, Anthropic,
   Stripe, ClamAV) is documented there with the phase that starts using it; all of it stays hidden until configured.
5. GitHub → Settings → General → **Default branch** → `main` (can't be changed from here).

## Known issues / notes

- Emails (verification, invitations) are written to the server log, not sent — a mail provider comes with notifications.
- Google/Microsoft login is wired but not verified here (needs your OAuth credentials).
- Trash is never purged automatically yet (that would permanently remove files); auto-purge after retention comes with admin settings (phase 11).
- The browser can't watch folders: changes made outside FolderPilot are picked up by Rescan, and show up as conflicts if a plan touches them.
- Plans made before this update that were waiting as agent "undo" proposals were cancelled by the upgrade; ask the agent again.
- Server spaces: Categories, Recent and Trash views still work on folders on this device only (they
  say which phase brings server spaces). The dev sample space is read-only until phase 9, so Auto rules that move or
  rename fail there with a "read-only" reason (tags, captions, categories and review flags work).
- Rules on server spaces run on a space when its files change, plus a 15-minute schedule tick; if files change while
  a rules run is already going, they're picked up by the next run or the tick (at most ~15 minutes later).
- On this device, scheduled rules only run while the app is open (browsers can't run in the background).
- The agent's rule proposals are always Suggest; only a person (an admin on servers) can make a rule Auto.
- Search by meaning needs an embedding model (an org AI that can embed, or `OLLAMA_URL` on the server). Without one,
  search uses words only and says so. Real embedding quality is untested here (mock embeddings only).
- Full-text uses the language-neutral `simple` configuration (no stemming), so "invoices" matches "invoice" only
  by prefix ("invoice" finds "invoices", not the other way round). Search by meaning covers the rest.
- Search results on server spaces open the file in All files (filtered by name); file previews come with Cloud mode.
- Conversations live in the browser tab (sessionStorage); they aren't saved on the server or shared across devices.
- File chips in server-space answers show names only (quick look for server files comes with Cloud mode previews).
- Real model quality isn't measured here: the agent is tested with scripted mock AIs (no Anthropic key in this
  environment).
- Progress for server jobs is polled every 1.5 s while work is running (SSE comes with phase 5 streaming).
- AI for server spaces is tested against mocks here (no Anthropic/Bedrock/Vertex credentials in this environment).
- Embeddings (search by meaning) for server spaces arrive in phase 6; per-space AI override in phase 9.
- `pnpm setup` is a built-in pnpm command, so the env script is `pnpm setup:env`.
- Docker Hub may rate-limit image pulls (429); `docs/SETUP.md` → Troubleshooting has the mirror workaround.
- English only (UI and agent), by decision.
- The repo isn't fully Prettier-formatted yet, so CI doesn't run a format check.
