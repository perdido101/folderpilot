# FolderPilot — Progress

## Phase 1 — Scaffold, theme, shell, intake, index, browse ✅

**Done**
- Vite 6 + React 18 + TypeScript (strict, `noUncheckedIndexedAccess`) + Tailwind 3 + shadcn/ui (new-york, `components.json` ready for `npx shadcn add …`).
- PWA via `vite-plugin-pwa` (manifest, 192/512 icons, auto-updating service worker). Fonts (Inter, JetBrains Mono) are bundled locally — no third-party network calls.
- **Clean Ledger theme**: all tokens from CLAUDE.md as CSS variables (`src/index.css`), mapped into Tailwind and onto shadcn names. Light / Dark / System toggle; theme applied before first paint (no flash). `prefers-reduced-motion` respected.
- **Layout shell**: sidebar with every section (Needs Review badge wired to Dexie, All Files, Categories, Rules, Duplicates & Bad Files, Audit Log, Trash, Settings — others are placeholder pages) + connected folders list; top bar with search, AI status pill placeholder, theme toggle, agent-panel toggle; collapsible right agent panel (placeholder).
- **Folder intake**: big drop zone ("Drop a folder here — or choose one"). Drag from Explorer uses `DataTransferItem.getAsFileSystemHandle()` + `requestPermission({ mode: 'readwrite' })`; "Choose folder" uses `showDirectoryPicker({ mode: 'readwrite' })`. Dropping a folder onto the file view also works. Friendly notice on browsers without the File System Access API.
- **Indexer** (`src/lib/indexer.ts`): recursive walk into Dexie (`roots`, `files` tables per the CLAUDE.md data model, later-phase fields optional), batched writes, live progress (files, folders, current path), cancel. Skips dot-files/folders (incl. `.folderpilot-trash`), Office `~$` lock files, `desktop.ini`, `Thumbs.db`, `$RECYCLE.BIN`, `System Volume Information`. Re-adding the same folder reuses its root (`isSameEntry`).
- **File browser**: grid (lazy thumbnails generated in a Web Worker with `OffscreenCanvas`) / table (sortable) toggle; search filters by name/path; multi-select (click, Ctrl/⌘-click, Shift-click range, Ctrl/⌘+A, Esc, arrow keys incl. Shift to extend); floating selection bar (actions disabled until Phase 4).
- **Quick-look** (Space / Enter / double-click): images, PDF (Chrome viewer), video/audio, text-like files; ←/→ to navigate, Space/Esc to close.
- `scripts/make-sample-folder.ts` (`npm run sample`): ~545 deterministic, valid files — photos (incl. burst near-duplicates, blurry, dark, tiny), desktop + phone screenshots, PDFs, DOCX, CSV, notes, zips, WAVs, ~70 exact duplicates (`(1)`, `- Copy`, `- Αντίγραφο`, Backup/), Greek names, deep "New folder" nesting, empty folders, and 8 hidden/system files the indexer must skip. `--force` only deletes a folder the script created.
- Vitest set up; tests for hidden/system skipping and extension → kind mapping.

**Verified**
- `npm run build` (typecheck + build) and `npm test` pass; `npm run dev` serves the app.
- End-to-end in headless Chromium (folder copied into OPFS, `showDirectoryPicker` stubbed to return it, and a synthetic drop carrying a real directory handle): 491 of 491 expected files indexed in ~1 s, 0 hidden/system files leaked, thumbnails, multi-select, Ctrl+A, quick-look navigation/close, table view, dark mode, folder drop, agent panel collapse — no console errors.
  (Headless OPFS refused the 46 Greek-named files, so the E2E count is 537 − 46; real folders aren't affected.)

**Known issues / notes**
- Real drag-and-drop from Windows Explorer and the native folder picker can only be tested by hand in Chrome/Edge.
- Folder access doesn't persist across restarts (out of scope per CLAUDE.md). The index stays in Dexie; after a reload the app shows an "Allow access" banner to re-grant access for previews and rescans.
- The browser can't see the Windows "hidden" attribute, so hidden files are detected by name only.
- Theme preference lives in localStorage (needed synchronously to avoid a flash), not the Dexie `settings` table.
- Grid renders all tiles (with `content-visibility: auto`); fine for a few thousand files. Add virtualization if folders get much larger.
- Rescan replaces the root's index (fine now — there's no analysis data yet). Phase 2+ should diff by path/mtime so analysis results are kept.

## Next — Phase 2
Local analysis worker (SHA-256, dHash, blur, brightness, tiny, screenshot heuristic, EXIF, PDF/DOCX text) + Duplicates & Bad Files view + keep/trash review mode, with Vitest tests for dHash/duplicate grouping.
