# FolderPilot — Progress

All 8 phases from CLAUDE.md are implemented. The app runs with `npm run dev` (Chrome/Edge desktop).

## Status by phase

| # | Phase | Status |
|---|-------|--------|
| 1 | Scaffold, theme, layout shell, drop/choose folder, indexing, grid/table, quick-look | ✅ |
| 2 | Local analysis worker + Duplicates & Bad Files + review mode | ✅ |
| 3 | AI provider layer + Settings + analysis pipeline + Needs Review | ✅ |
| 4 | Action engine: plans, approve/execute, `moveFile()`, Trash, audit log, undo, undo toasts | ✅ |
| 5 | Rules: structured builder, natural-language rules, test/dry-run, "Make this a rule?" | ✅ |
| 6 | Agent chat with tools + Plan Cards | ✅ |
| 7 | Search (keyword + semantic) | ✅ |
| 8 | Command palette, shortcuts overlay, mini mode, polish, empty states | ✅ |

## What's where

- `src/lib/actions/engine.ts` — the **only** code that changes files or their organization. Plans → approve → execute → audit entries per batch → undo (entry or batch). No delete operation exists; trash = move to `.folderpilot-trash/` with the original path stored.
- `src/lib/actions/fs-ops.ts` — `moveFile()`: `FileSystemHandle.move()` when available, otherwise copy → verify size → remove original. Never overwrites (`(2)`, `(3)`…). Case-only renames go through a temp name.
- `src/workers/analysis.worker.ts` — SHA-256, dHash, contrast-normalized sharpness, brightness, size, EXIF (exifr), text from TXT/CSV/… and DOCX (mammoth). PDF text via pdf.js (first 2 pages, lazy-loaded). Runs in a pool of workers; results are written in batches.
- `src/lib/analysis/duplicates.ts` — exact groups (SHA-256), near-duplicates (dHash ≤ 6 bits, same aspect ratio, screenshots excluded), keep-best (resolution → sharpness → oldest → clean name), all flags.
- `src/lib/ai/` — `AIProvider` interface + Ollama, OpenAI-compatible and Anthropic (official SDK, `dangerouslyAllowBrowser`, structured outputs, refusal fallbacks on api.anthropic.com) providers; zod-validated JSON; confidence < threshold → Needs Review. Only ≤512px JPEG thumbnails or extracted text are sent.
- `src/lib/rules/` — conditions/actions, templates (`{year}` `{month}` `{date}` `{category}` `{client}` `{type}` `{name}` `{ext}`), dry-run, combined plans by priority.
- `src/lib/agent/` — tools: `get_overview`, `list_files`, `search_files`, `get_file`, `propose_plan`, `create_rule`, `update_rule`, `flag_for_deletion`, `explain`, `undo`, `list_recent_actions`. **No delete tool.** All changes become pending plans. Works offline as keyword search when no AI is set.
- `src/lib/search.ts` — keyword search (accent-insensitive, years, "photos/pdf/screenshots", plural folding) + semantic search via `embed()` and cosine similarity (vectors in Dexie).
- `/mini` — standalone compact layout (drop zone, agent, plan cards, last actions with Undo, "Open full app") for the future Tauri tray popup.

## Verified

- `npm run build` (strict typecheck + build) and `npm test` — **98 tests** in 7 files: `moveFile` (native move and copy fallback), engine/undo (batch, single, trash/restore, rules, flags), rules evaluation, dHash/duplicate grouping/flags, AI JSON parsing, search, file kinds.
- End-to-end in headless Chromium on the generated sample folder (copied into OPFS; `showDirectoryPicker` stubbed to return it) with a **test-only fake OpenAI-compatible server** (not shipped):
  - 491 files indexed in ~1 s, analyzed locally in ~17 s; flags match the sample's ground truth (71 exact copies, 6 burst near-duplicates, 15 blurry + 2 copies, 10 dark, 15 tiny, 70 screenshots, 0 false blurry/near-dup).
  - Review mode (← trash / → keep), "Trash all copies, keep best", Undo toast, Trash → Restore all; files verified on disk.
  - Settings → Test connection; AI analysis of all files (only 512px JPEG thumbnails sent, ~27 KB each); Needs Review accept; categories; drag file onto category → "Make this a rule?".
  - Agent: find (“signed NDA with Alpha”), organize by client → Plan Card → nothing on disk until Approve → files moved; "make a rule" → approve → run rule (70 files → Temp) → undo batch (all back); flag for deletion → Needs Review (nothing trashed); Greek reply.
  - Tag + rename with AI names via the floating bar; inline caption edit in quick-look; Ctrl+K palette; `?` overlay; mini mode; dark mode. No console errors.

## Browser support

- **Chrome / Edge (desktop):** full mode, with read and write access through the File System Access API.
- **Brave, Firefox, Safari:** **read-only mode**. Folders open through the standard folder picker or drag-and-drop (`webkitdirectory` / `webkitGetAsEntry`). Indexing, local analysis, AI, agent and search all work; moves, renames and trash are refused with a clear message. Read-only folders must be chosen again after a reload. In Brave, full mode can be enabled at `brave://flags/#file-system-access-api`.

## Known issues / notes

- **Real AI not tested from here**: no Ollama or API key in this environment. The provider code follows each API's documented format and was exercised against a fake OpenAI-compatible server. Please run *Settings → Test connection* with your provider. For Ollama, set `OLLAMA_ORIGINS` (instructions in Settings).
- Real drag-and-drop from Windows Explorer and the native folder picker need a manual check in Chrome/Edge (the headless test uses OPFS).
- The copy fallback in `moveFile()` can't preserve the file's modified date (browser limitation). Chrome/Edge 110+ use native `move()`, which does.
- Folder access doesn't persist across restarts (out of scope); the index does. An "Allow access" banner re-grants it.
- AI insights (category, tags, caption, suggested name) are stored in the index as suggestions; anything that changes files on disk (rename/move) still goes through a plan.
- Undo is blocked for a file that moved again later (undo the later change first) and for batches still executing.
- Hidden files are detected by name only (browsers can't read the Windows "hidden" attribute).
- Headless OPFS rejects some Greek file names, so the E2E count is 537 − 46; real folders are unaffected.
- Main bundle ~1.1 MB (pdf.js is lazy-loaded). Further code-splitting is possible.

## Next ideas

- Persisted folder permissions (when in scope), watched folders.
- Virtualized grid for 10k+ files.
- Streaming agent replies; richer plan editing (change destinations inline).
- Tauri tray app using `/mini`.
