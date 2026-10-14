# FolderPilot — CLAUDE.md (Product spec v2)

> This is a real product, not a prototype. Build production-quality code: typed, tested, secure, documented.
> Work through the phases at the bottom in order. After each phase: app runs, tests pass, PROGRESS.md updated, git commit.
> If an existing prototype is in this repo, migrate it into the new structure — reuse UI components, rules engine, analysis workers.

## 1. What FolderPilot is
FolderPilot **organizes, finds and cleans files** with an AI agent you can talk to in plain language,
custom rules (structured + natural language), duplicate/bad-file detection, captions, and search by meaning.
B2B first (small offices, agencies, accountants, law firms), consumer second.

**One product, three modes** — same UI, same engine, different file source:
1. **Connect** — organizes files where they already live: Google Drive, OneDrive/SharePoint, Dropbox. We store only metadata + index, never the files.
2. **Cloud** — FolderPilot's own storage (S3-compatible: Cloudflare R2 / Backblaze B2 / Hetzner). Upload via web, desktop app, or Explorer sync drive.
3. **Private** — files never leave the customer's systems. Either (a) a single user in the browser/desktop app on a local folder, or (b) a self-hosted server (Docker) on the company network pointing at their NAS/file share. AI = local (Ollama) or their own cloud AI endpoint.

## 2. Non-negotiable principles
1. **The AI agent can NEVER delete.** No delete tool exists anywhere — not in the agent, not in the MCP server. It may only *flag* files "suggested for deletion". Only a human trashes files; trash is recoverable (FolderPilot Trash or the provider's own trash), retention configurable (default 30 days).
2. **Plan → Approve → Execute.** Every change by agent, rule, MCP client or bulk action is first a Plan (before/after, file count). Nothing changes until a human with permission approves. Admins may allow auto-run for small plans (configurable threshold) and for rules explicitly set to "auto".
3. **Everything audited and reversible.** Append-only audit log (DB-enforced: no UPDATE/DELETE). Undo per action and per batch. Undo checks for conflicts (file changed since) and asks instead of overwriting.
4. **Privacy by mode.** In Private mode no file content or thumbnail leaves the customer environment except to the AI endpoint they configured. In all modes: send AI only thumbnails (≤512px) or extracted text, never full files. We never train on customer files.
5. **Tenant isolation.** Every query is scoped by organization. Tokens and keys encrypted at rest.
6. **Simple, calm UI.** Clean Ledger theme, light + dark. Familiar cloud-drive conventions, our own look.

## 3. Architecture (monorepo: pnpm + Turborepo, TypeScript strict everywhere)
```
apps/
  web/        Vite + React SPA (main app + /mini compact mode)
  server/     Node API (Hono) — auth, orgs, files, plans, rules, agent, search, billing, webhooks
  worker/     Background jobs (BullMQ): indexing, analysis, AI, embeddings, rule runs, provider sync
  mcp/        MCP server (stdio + Streamable HTTP)
  desktop/    Tauri 2 app: tray icon + mini window, local folders, uploader, Explorer sync drive (Windows)
packages/
  core/       Domain logic: types, storage-adapter interface, action/plan engine, rules engine, undo, audit
  ai/         AI provider layer + prompts + zod schemas
  analysis/   dHash, blur, brightness, EXIF, text extraction (shared by browser workers and server worker)
  ui/         Shared React components (shadcn/ui based), theme tokens
  db/         Drizzle schema + migrations (Postgres + pgvector)
deploy/
  docker-compose.selfhost.yml   Private-mode server: server, worker, mcp, postgres, redis, ollama (optional)
  docker-compose.dev.yml
```
**Tech:** Hono, Drizzle ORM, PostgreSQL 16 + pgvector, Redis + BullMQ, Better Auth (email, Google, Microsoft, organizations, SSO-ready), Stripe, AWS SDK v3 (S3-compatible), sharp (server thumbnails), pdfjs / mammoth / exifr, ClamAV (upload scanning, Cloud mode), Vitest + Playwright, zod everywhere at boundaries.
Frontend: React, TypeScript, Tailwind, shadcn/ui, lucide-react, framer-motion (subtle), Zustand, TanStack Query, cmdk.

## 4. Storage adapter (the heart of the three modes)
All file I/O goes through one interface in `packages/core`. Nothing else touches files.
```ts
interface StorageAdapter {
  id: 'local-browser' | 'local-server' | 'fp-cloud' | 'gdrive' | 'onedrive' | 'dropbox';
  list(path: string, cursor?: string): Promise<Page<FileEntry>>;
  stat(ref: FileRef): Promise<FileEntry>;               // includes version/etag for conflict checks
  readThumbnail(ref: FileRef, maxPx: number): Promise<Blob | null>;
  readText(ref: FileRef, maxChars: number): Promise<string | null>;
  download(ref: FileRef): Promise<ReadableStream>;      // for preview/download only
  upload?(parent: FileRef, file: Blob, name: string): Promise<FileEntry>;
  move(ref: FileRef, newParent: FileRef, opts: { expectVersion: string }): Promise<FileEntry>;
  rename(ref: FileRef, newName: string, opts: { expectVersion: string }): Promise<FileEntry>;
  createFolder(parent: FileRef, name: string): Promise<FileEntry>;
  trash(ref: FileRef): Promise<void>;                   // HUMAN-ONLY, enforced by the action engine
  restore(ref: FileRef): Promise<void>;
  changes(cursor?: string): Promise<{ entries: ChangeEvent[]; cursor: string }>; // incremental sync
  subscribe?(webhookUrl: string): Promise<Subscription>; // push notifications where supported
}
```
Implementations:
- **local-browser** — File System Access API (Chrome/Edge): folder drag-drop via `getAsFileSystemHandle()`, `showDirectoryPicker`, `move()` with copy+verify+remove fallback. Trash = `.folderpilot-trash/`.
- **local-server** — Node fs on mounted paths (NAS/SMB) for self-hosted Private mode; chokidar watcher for changes.
- **fp-cloud** — S3-compatible bucket; folders/structure live in Postgres (objects keyed by id, not path, so moves are DB-only); versioning on; multipart + resumable uploads; quotas per org.
- **gdrive** — Google Drive API v3: `files.list`, `changes.list` + `changes.watch`, move via `addParents/removeParents`, rename via `name`, thumbnails via `thumbnailLink`, Docs export as text, trash via `trashed=true`.
- **onedrive** — Microsoft Graph: drive items, `delta` query, subscriptions (webhooks), `PATCH parentReference/name`, thumbnails endpoint; supports SharePoint document libraries.
- **dropbox** — `list_folder` + `/continue` cursors, webhooks, `move_v2`, `get_thumbnail_v2`, trash via `delete_v2` (recoverable in Dropbox).
OAuth tokens encrypted (AES-256-GCM, key from env), refreshed automatically. Respect provider rate limits with backoff.

## 5. AI provider layer (`packages/ai`)
```ts
interface AIProvider {
  describeImage(thumb: Blob, ctx: AnalyzeContext): Promise<FileInsight>;
  describeText(text: string, meta: FileMeta, ctx: AnalyzeContext): Promise<FileInsight>;
  chat(messages: ChatMessage[], tools: ToolDef[], opts?: ChatOpts): AsyncIterable<ChatEvent>; // streaming + tool calls
  embed(texts: string[]): Promise<number[][]>;
}
// FileInsight: { category, tags[], caption, suggestedName, entities {client?, date?, amount?, docType?}, confidence }
```
Implementations: **FolderPilot AI** (our hosted default: Anthropic Claude via our key — small fast model for analysis, stronger model for the agent), **Ollama** (local), **OpenAI-compatible** (Azure OpenAI, gateways, LM Studio, vLLM), **Anthropic / Bedrock / Vertex** (customer's own account).
- Configurable per org, overridable per folder/space (e.g. /Legal = local only).
- Strict JSON outputs validated with zod; confidence < 0.6 → "Needs Review", never guess.
- Prompt includes active natural-language rules + org category list + language preference (Greek/English, detect per file).
- Embeddings: provider embed when available; fallback local embedding model via Ollama; final fallback keyword-only.
- Cost controls: per-org monthly AI budget, batch processing for bulk imports, cache results by content hash (same file = no re-analysis).
- Top bar AI status pill: "FolderPilot AI" / "Local AI" / "Your cloud: <name>" + test connection.

## 6. Data model (Postgres, `packages/db`)
- `organizations`, `users`, `memberships` (role: owner | admin | editor | viewer), `invitations`
- `spaces` — a connected source: mode, adapter id, root ref, encrypted credentials, sync cursor, settings (AI provider override, auto-run threshold)
- `files` — id, org, space, providerRef, parentId, path, name, ext, mime, size, mtime, version/etag, sha256, dhash, blurScore, brightness, width, height, exif (jsonb), textExcerpt, category, tags[], caption, suggestedName, entities (jsonb), confidence, status, flags[], embedding vector(1024)
- `versions` — file version history (Cloud mode)
- `rules` — type structured|natural, scope (org/space/folder), priority, enabled, mode (suggest|auto), conditions (jsonb), actions (jsonb), naturalText, createdBy
- `plans` + `plan_steps` — source (user|agent|rule|mcp), summary, status (pending|approved|executing|executed|partially_failed|cancelled), approvedBy
- `audit_events` — append-only (trigger blocks UPDATE/DELETE): at, org, actor (user:<id> | agent:<user> | rule:<id> | mcp:<client>:<user>), action, fileIds, before, after, reason, planId, batchId, undoneBy
- `trash_items`, `shares` (Cloud mode links), `api_keys` (MCP/API, hashed), `ai_usage`, `subscriptions` (Stripe), `notifications`

## 7. Action & plan engine (`packages/core`)
- The ONLY path that changes files. Steps: move | rename | createFolder | tag | caption | setCategory | trash (human-only) | restore.
- Validates permissions (user role + folder access), enforces "no trash unless actor is a human user", checks `expectVersion` per step (conflict → step marked conflicted, user decides).
- Executes in batches with progress events (SSE/WebSocket to UI), idempotent and resumable.
- Writes audit events per step; produces an inverse plan for undo.
- Undo single action / whole batch / "everything the agent did since X".

## 8. Rules engine
- **Structured**: IF conditions (type, ext, name/content contains, regex, date range, size, folder, AI category, entity e.g. client, has flag, source space) THEN actions (move to path with variables `{year} {month} {category} {client} {docType}`, rename pattern, tag, caption, flag for review, set category).
- **Natural language**: free text, injected into AI context; agent offers conversion to structured (shown as a proposal).
- Order: structured by priority → natural via AI → AI default. First matching move wins; tags accumulate.
- Mode per rule: suggest (creates plans) or auto (executes, still audited + undoable).
- Dry-run "Test rule" with affected count + sample. "Make this a rule?" after manual recategorization.
- Runs on: new/changed files (from sync/webhooks/uploads), manual "Run on folder", schedule.

## 9. Agent
Streaming chat panel (right side, collapsible) + mini mode + command palette entry. Tools:
`search_files`, `list_files`, `get_file`, `explain_categorization`, `propose_plan`, `propose_rule`, `update_rule_proposal`, `flag_for_deletion`, `propose_undo`, `get_audit(filter)`, `stats(question)` (counts/aggregates over the index).
No delete/trash tool. All changes returned as Plan Cards: summary, count, before/after preview, Approve / Edit / Cancel. Answers in the user's language. Scoped to what the user can access. Every tool call logged.

## 10. MCP server (`apps/mcp`)
Purpose: let OTHER AI apps use FolderPilot (Claude Desktop, Claude Code, ChatGPT-style clients, local-LLM apps like LM Studio / Ollama front-ends that support MCP).
- Transports: **stdio** (Private/local; launched by desktop app or `npx folderpilot-mcp`) and **Streamable HTTP** at `/mcp` (Cloud/Connect; OAuth 2.1 or per-user API key).
- Tools mirror the agent tools: search_files, list_files, get_file, explain_categorization, propose_plan, propose_rule, flag_for_deletion, get_audit, stats. **No delete. No approve.** Proposed plans appear in the FolderPilot UI "Pending approvals" for a human; tool returns the plan id + a link.
- Optional admin setting: allow MCP clients to auto-run plans under N files (default off).
- Resources: `folderpilot://file/{id}` (metadata + caption + text excerpt), `folderpilot://rules`. Prompts: "organize folder", "find document".
- Actor in audit = `mcp:<clientName>:<userId>`. Rate-limited. Scoped to the key's user permissions.
- README section: config snippets for Claude Desktop, Claude Code, and a local-LLM MCP client.

## 11. Search
Hybrid: Postgres full-text (name, path, caption, tags, extracted text, entities) + pgvector semantic similarity, merged with reciprocal-rank fusion. Filters: type, date, category, space, flags, person/client. Natural queries in search bar and agent.

## 12. Local analysis (no AI cost)
SHA-256 exact duplicates; dHash near-duplicates (Hamming ≤ 6, configurable); Laplacian blur; brightness; tiny images; screenshot heuristic; EXIF; text extraction (PDF first pages, DOCX, TXT, Google Docs export). "Keep best" suggestion for duplicate groups. Runs in browser Web Workers (local-browser) or worker service (all other modes).

## 13. Cloud mode specifics
Uploads: drag-drop files/folders, resumable multipart, progress tray. ClamAV scan on upload. Previews: images, PDF, video/audio, text; Office files via viewer integration (placeholder adapter, later OnlyOffice/Collabora). Share links (view/download, expiry, password). Version history + restore. Storage quotas per plan, usage meter, pay-as-you-go overage counted daily. Abuse report endpoint + admin takedown flow. EU region by default.

## 14. Desktop app (`apps/desktop`, Tauri 2)
- **Tray icon** (bottom-right) → **mini window** (~400×520) above the tray: drop zone (drag folders/files from Explorer), prompt box, results/Plan Cards, last actions + Undo, "Open full app". Reuses the web `/mini` components.
- Global shortcut (Ctrl+Shift+Space) to open mini window.
- Local folders as `local-server`-style adapter via Rust fs commands (Private mode, single user).
- **Uploader**: choose folders to upload/back up to Cloud mode (one-way, resumable).
- **Explorer integration (Windows)**: context menu "Organize with FolderPilot" / "Ask FolderPilot about this folder".
- **Sync drive (Windows, last phase)**: Windows Cloud Files API (cfapi) placeholders — FolderPilot appears in Explorer, files hydrate on open, status icons, two-way sync with conflict copies. Use a maintained Rust crate (e.g. `cloud-filter`). Build behind a feature flag.
- Auto-update, code signing placeholders, launches stdio MCP server on demand.

## 15. Billing (Stripe) — config-driven, prices are placeholders
Plans defined in `packages/core/plans.ts` (limits: storage GB, AI files/month, seats, features). Tentative: Free, Personal, Plus, Business (per seat), Connect-only (per seat), Private (license key, manual invoicing). Pay-as-you-go storage overage via metered billing. Checkout, customer portal, webhooks, grace periods. Feature gates read from the plan.

## 16. UI / UX (Clean Ledger)
Familiar cloud-drive conventions (left nav, big "New" button, breadcrumbs, grid/list, right-click menus, details panel, Recent, Shared, Trash) — our own look, never copy another product's layout, colors, icons or wording.
- **Left sidebar**: New (Upload / New folder / Connect source), Spaces (each connected source with mode badge), Needs Review (badge), Recent, Categories, Duplicates & Bad Files, Rules, Pending Approvals, Audit Log, Shared (Cloud), Trash, Settings / Admin.
- **Center**: grid/list toggle, breadcrumbs, multi-select + floating action bar, inline editing, quick-look (Space), review mode (→ keep / ← trash), drop zone empty state.
- **Right**: Agent panel (docked, collapsible) + Details panel (file history, why categorized, versions).
- **Top bar**: hybrid search, AI status pill, notifications, theme toggle, org switcher.
- Command palette (Ctrl/⌘+K), keyboard shortcuts + "?" overlay, undo toasts, live processing shimmer, onboarding wizard (pick mode → connect source → pick starter rules → first organize).
- `/mini` route: compact mode (also used by desktop tray).
- Admin: members & roles, spaces, AI provider settings, auto-run thresholds, retention, MCP/API keys, billing, audit export (CSV/PDF).
- i18n: English + Greek from day one (all strings in locale files).

Theme tokens (CSS variables): Inter (UI), JetBrains Mono (paths/audit).
Light: --bg #FAFAF7 · --surface #FFFFFF · --surface-2 #F3F2EE · --border #E6E4DE · --text #1F2328 · --muted #6B7280 · --accent #0F766E · --accent-soft #E6F2F0 · --success #15803D · --warning #B54708 · --danger #B42318
Dark: --bg #0F1114 · --surface #16191D · --surface-2 #1C2025 · --border #262A30 · --text #E7E9EC · --muted #9AA1AB · --accent #2DD4BF · --accent-soft #12302C · --success #4ADE80 · --warning #FBBF24 · --danger #F87171
8px radius, 1px borders over shadows, one accent, motion 150–200ms ease-out, prefers-reduced-motion respected.

## 17. Security & compliance
Better Auth sessions, CSRF protection, rate limiting, input validation (zod), encrypted secrets (AES-256-GCM), least-privilege OAuth scopes, signed webhook verification, RLS-style org scoping enforced in a single data-access layer, security headers/CSP, dependency audit in CI, GDPR: data export + account deletion (human-initiated, with grace period), DPA-ready docs in /docs, structured logs without file contents.

## 18. Configuration
`.env.example` documenting every variable, grouped: DATABASE_URL, REDIS_URL, APP_URL, ENCRYPTION_KEY, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET/TENANT, DROPBOX_APP_KEY/SECRET, S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET/REGION, ANTHROPIC_API_KEY, FP_AI_ANALYSIS_MODEL, FP_AI_AGENT_MODEL, OLLAMA_URL, STRIPE_SECRET_KEY/WEBHOOK_SECRET/PRICE_IDs, CLAMAV_HOST, MCP_PUBLIC_URL. Everything that needs an external account must degrade gracefully (feature hidden + "not configured" notice) so the app runs locally with only Postgres + Redis.
`docs/SETUP.md`: step-by-step for creating each external app/key (Google Cloud OAuth, Microsoft Entra app, Dropbox app, Stripe, R2/B2 bucket, Anthropic key, Ollama).

## 19. Quality
Vitest unit tests (action engine, undo, conflicts, rules, adapters with mocks, AI JSON parsing, dHash), integration tests against Postgres, Playwright E2E for core flows (connect/upload → analyze → review → rule → agent plan → approve → undo). Seed script + messy sample dataset generator (500+ mixed files). CI (GitHub Actions): lint, typecheck, test, build. PROGRESS.md after every phase.

## 20. Build phases
1. **Monorepo + foundations**: Turborepo, packages, db schema + migrations, Better Auth with organizations/roles, Hono API skeleton, web app shell with theme/i18n/layout, docker-compose.dev. Migrate any existing prototype code.
2. **Core engine**: StorageAdapter interface, action/plan engine, audit (append-only), undo, trash/restore, conflict checks — with full tests. `local-browser` adapter wired to the web app.
3. **Analysis + AI**: analysis package (browser + worker), BullMQ worker, AI provider layer (all four providers), insight pipeline, Needs Review, Duplicates & Bad Files + review mode.
4. **Rules**: structured builder UI, natural rules, dry-run, auto/suggest modes, triggers.
5. **Agent**: tools, streaming chat, Plan Cards, Pending Approvals, command palette integration, mini mode.
6. **Search**: full-text + pgvector hybrid, filters, search UI.
7. **Cloud mode**: fp-cloud adapter, uploads, previews, versions, shares, quotas, ClamAV.
8. **Connect mode**: Google Drive, OneDrive/SharePoint, Dropbox adapters, OAuth, changes/webhooks sync.
9. **Private mode**: local-server adapter, docker-compose.selfhost, license key check, AI per-space override.
10. **MCP server**: stdio + HTTP, tools/resources/prompts, auth, docs with client configs.
11. **Billing + admin**: Stripe plans, metering, feature gates, admin pages, audit export, GDPR export/delete.
12. **Desktop app**: Tauri tray + mini window, global shortcut, local folders, uploader, Explorer context menu, stdio MCP launcher.
13. **Windows sync drive** (feature flag): cfapi placeholders, hydration, two-way sync, conflicts.
14. **Hardening**: E2E suite, performance with 100k files, security review checklist, onboarding polish, docs.
