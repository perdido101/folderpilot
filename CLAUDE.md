# FolderPilot — CLAUDE.md

## What we're building
FolderPilot is a web app (installable PWA) that **organizes, finds and cleans** messy files on the user's own computer.
The user drags a folder from Windows Explorer into the app; FolderPilot indexes it, categorizes and renames files,
finds duplicates and bad photos, writes captions, and lets the user talk to an AI agent in plain language
("organize this by client", "find the signed NDA with Alpha", "make a rule: screenshots go to /Temp").

Primary market: **B2B** (small offices: accountants, law firms, agencies). Consumer version later.

## Non-negotiable principles
1. **Files never leave the user's machine.** No backend touches files. The only network calls are to the AI provider the user configured (local Ollama, or their own cloud endpoint). Never send full files to any AI — send thumbnails (max 512px) or extracted text only.
2. **The AI agent can NEVER delete.** There is no delete tool. It can only *flag* files as "suggested for deletion". Only a human can trash files, and trashing = moving to the FolderPilot Trash folder, never permanent deletion.
3. **Plan → Approve → Execute.** Every change (move, rename, tag, caption, rule change) made by the agent or by rules is first shown as a plan (before/after, file count). Nothing touches the disk until the user clicks Approve.
4. **Everything is logged and reversible.** Append-only audit log of every action (who: user/agent/rule, what, files, old → new, when, why). Undo per action and per batch.
5. **Simple, calm UI.** Clean Ledger theme, light + dark. Fast, keyboard-friendly, no clutter.

## Scope for this prototype
IN: drag & drop folder, indexing, grid/list views, local analysis (duplicates, bad photos), AI categorization/captions/rename suggestions, structured + plain-language rules, plan/approve/execute engine, audit log + undo, Trash, agent chat, search, command palette, mini mode, light/dark.
OUT (for now): watched folders, persistent folder permissions across restarts, accounts/login, multi-user/roles, connectors (SharePoint/Drive), desktop tray app (later via Tauri — keep UI components reusable so mini mode can become the tray popup).

## Tech stack
- Vite + React + TypeScript (strict)
- Tailwind CSS + shadcn/ui, lucide-react icons, framer-motion (subtle only)
- Zustand for UI state
- Dexie (IndexedDB) for index, rules, audit log, settings
- Web Workers for heavy work (hashing, image analysis) — never block the UI thread
- Libraries: exifr (EXIF), pdfjs-dist (PDF text), mammoth (DOCX text), cmdk (command palette)
- PWA (vite-plugin-pwa) so it installs as its own window
- Target browsers: Chrome & Edge desktop. Show a friendly notice on others.

## File access (File System Access API)
- Folder drop: in the drop handler use `DataTransferItem.getAsFileSystemHandle()`; if it's a directory handle, call `requestPermission({ mode: 'readwrite' })`.
- Also offer a "Choose folder" button using `showDirectoryPicker({ mode: 'readwrite' })`.
- Move/rename: use `FileSystemHandle.move()` when available; otherwise copy to destination, verify size, then remove the original. Wrap in one function `moveFile()` with tests.
- Trash: a hidden `.folderpilot-trash/` folder inside the root folder; store original path so it can be restored.
- Skip system/hidden files and the trash folder when indexing.

## AI provider layer
One interface, three implementations, chosen in Settings:
```ts
interface AIProvider {
  describeImage(thumb: Blob, ctx: AnalyzeContext): Promise<FileInsight>; // category, tags, caption, suggestedName, confidence
  describeText(text: string, meta: FileMeta, ctx: AnalyzeContext): Promise<FileInsight>;
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResult>; // tool calling for the agent
  embed?(texts: string[]): Promise<number[][]>;
}
```
1. **Local — Ollama** at `http://localhost:11434` (user must set `OLLAMA_ORIGINS` to allow the app's origin; show instructions in Settings). Default models configurable (a small vision model + a small text model).
2. **Bring your own — OpenAI-compatible endpoint** (covers Azure OpenAI, many gateways, local servers): base URL + key + model.
3. **Bring your own — Anthropic** (Claude API or their Bedrock/Vertex proxy): base URL + key + model. Direct browser calls need header `anthropic-dangerous-direct-browser-access: true`.
- Keys are stored locally only (IndexedDB), never sent anywhere except the chosen endpoint.
- Always request strict JSON output; validate with zod; on low confidence (< 0.6) send the file to "Needs Review" instead of guessing.
- Top bar shows an AI status pill: "Local AI" (green) or "Your cloud: <name>" (blue), with a test-connection button.

## Data model (Dexie)
- `roots` — connected folders (handle, name, addedAt)
- `files` — id, rootId, path, name, ext, size, mtime, sha256, dhash, blurScore, brightness, width, height, exif, textExcerpt, category, tags[], caption, suggestedName, confidence, status ('indexed'|'analyzed'|'needs_review'|'organized'|'trashed'), flags[] ('duplicate'|'near_duplicate'|'blurry'|'dark'|'tiny'|'screenshot'|'suggested_delete')
- `rules` — id, type ('structured'|'natural'), name, enabled, priority, conditions[], actions[], naturalText, createdBy, createdAt
- `plans` — id, source ('agent'|'rule'|'user'), summary, steps[] ({fileId, action, from, to, before, after}), status ('pending'|'approved'|'executed'|'cancelled')
- `audit` — append-only: id, at, actor ('user'|'agent'|'rule:<id>'), action, fileIds[], before, after, reason, planId, batchId, undone (bool)
- `settings` — theme, aiProvider config, thresholds

## Rules engine
- **Structured rules**: visual IF → THEN builder.
  - Conditions: file type/extension, name contains, content contains, date range, size, folder, AI category, has flag.
  - Actions: move to folder (supports variables `{year}`, `{month}`, `{category}`, `{client}`, `{type}`), rename by pattern, add tag, set caption, flag for review.
- **Natural-language rules**: free text, injected into the AI prompt. The agent offers to convert them to structured rules when possible (shown for user approval).
- Order: structured rules first (by priority) → natural-language rules (via AI) → AI default categorization.
- "Test rule" button: dry-run shows how many and which files would be affected.
- When a user drags a file to a different category, offer: "Make this a rule?"

## Agent (chat panel)
Tools available to the agent (NO delete tool exists):
- `list_files(filter)`, `search_files(query)`, `get_file(id)`
- `propose_plan(steps, summary)` — moves, renames, tags, captions
- `create_rule(rule)` / `update_rule(id, changes)` — always as a proposal needing approval
- `flag_for_deletion(fileIds, reason)` — only flags; human decides in Review
- `explain(fileId)` — why a file was categorized the way it was
- `undo(batchId)` — proposes an undo plan
Behavior: answer questions directly; for any change, return a Plan Card (summary, file count, before/after preview, Approve / Edit / Cancel). Respect the current folder scope. Reply in the user's language (Greek or English).

## Search
- Keyword search over name, path, caption, tags, extracted text.
- Semantic search via `embed()` when the provider supports it (cosine similarity, vectors stored in Dexie). Fall back to keyword if not.
- Natural queries in the search bar or agent ("the signed NDA with Alpha from 2025").

## Local analysis (Web Worker, no AI, free)
- SHA-256 → exact duplicates. dHash (64-bit) → near-duplicates (Hamming distance ≤ 6, configurable).
- Blur: Laplacian variance on a downscaled grayscale image. Brightness: mean luminance. Tiny: < 300px.
- Screenshot heuristic: filename patterns + common screen aspect ratios + no EXIF camera.
- EXIF via exifr. PDF text via pdfjs (first 2 pages). DOCX via mammoth.
- Duplicate groups suggest "keep best" (highest resolution, sharpest, oldest original).

## UI / UX
Layout:
- **Left sidebar**: Needs Review (badge), All Files, Categories, Rules, Duplicates & Bad Files, Audit Log, Trash, Settings.
- **Center**: grid (images) / table (docs) toggle; big drop zone when empty ("Drop a folder here — or choose one").
- **Right panel**: Agent chat, docked, collapsible.
- **Top bar**: search, AI status pill, theme toggle.

Modern, simple interactions:
- Command palette (Ctrl/⌘+K) for navigation, actions and asking the agent
- Drag & drop everywhere (folders into the app, files onto categories, files into chat)
- Multi-select with floating action bar (Move / Tag / Rename / Ask agent / Trash)
- Inline editing of name, caption, tags
- Quick-look preview (Space) with arrow-key navigation
- Review mode for duplicates/bad photos: keep (→) / trash (←), keyboard + click
- Undo toast after every action ("Moved 23 files · Undo")
- Per-file processing shimmer while AI works, then it settles into its category
- Keyboard shortcuts with a "?" overlay
- **Mini mode**: compact window layout (~400×520) with drop zone, prompt box, results/plan cards, last actions with Undo, and "Open full app". Build it as a standalone route/component (`/mini`) — it will later become the Tauri tray popup.

## Theme: Clean Ledger (light + dark)
Use CSS variables + Tailwind. Font: Inter (UI), JetBrains Mono (paths, audit log).
Light:
- --bg #FAFAF7 · --surface #FFFFFF · --surface-2 #F3F2EE · --border #E6E4DE
- --text #1F2328 · --muted #6B7280
- --accent #0F766E (deep teal) · --accent-soft #E6F2F0
- --success #15803D · --warning #B54708 · --danger #B42318
Dark:
- --bg #0F1114 · --surface #16191D · --surface-2 #1C2025 · --border #262A30
- --text #E7E9EC · --muted #9AA1AB
- --accent #2DD4BF · --accent-soft #12302C
- --success #4ADE80 · --warning #FBBF24 · --danger #F87171
Style rules: 8px radius, 1px borders instead of heavy shadows, generous spacing, one accent color, motion 150–200ms ease-out, respect prefers-reduced-motion. Light/dark/system toggle.

## Build phases (do one at a time; app must run after each)
1. Scaffold, theme (light/dark), layout shell, drop/choose folder, index files, grid/list view, quick-look.
2. Local analysis worker + Duplicates & Bad Files view + review mode.
3. AI provider layer + Settings + analysis pipeline (categories, tags, captions, suggested names) + Needs Review.
4. Action engine: plans, approve/execute, moveFile(), Trash, audit log, undo (single + batch), undo toasts.
5. Rules: structured builder, natural-language rules, test/dry-run, "make this a rule?".
6. Agent chat with tools + Plan Cards.
7. Search (keyword + semantic).
8. Command palette, shortcuts overlay, mini mode, polish, empty states.

## Engineering rules
- TypeScript strict, small components, no `any`.
- All disk-changing code goes through the action engine — nothing else may move/rename files.
- Write unit tests (Vitest) for: moveFile, rules evaluation, undo, dHash/duplicate grouping, AI JSON parsing.
- Test with a messy sample folder of 500+ mixed files (images, PDFs, DOCX, screenshots, duplicates). Create a script `scripts/make-sample-folder.ts` that generates one.
- Keep a `PROGRESS.md` updated after each phase: what's done, what's next, known issues.
