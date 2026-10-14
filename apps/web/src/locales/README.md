# Locales (English + Greek)

Every user-visible string lives here — never hard-code text in components.

- One JSON file per namespace (feature), in both `en/` and `el/`. English is the source of truth.
- Keys are camelCase, grouped by screen element: `{ "toolbar": { "rescan": "Rescan" } }`.
- Use from React: `const { t } = useTranslation("files"); t("toolbar.rescan")`.
- Keys from another namespace (typed!): load it too — `const { t } = useTranslation(["files", "common"]); t("common:actions.cancel")` — or pass `{ ns: "common" }`: `t("actions.cancel", { ns: "common" })`. A bare `t("common:…")` with only one namespace loaded fails the type-check.
- Outside React (stores, lib): `import i18n from "@/i18n"; i18n.t("moved", { ns: "actions", count })`.
- Interpolation: `"Moved {{count}} files"` → `t("moved", { count })`.
- Plurals: `"file_one": "{{count}} file", "file_other": "{{count}} files"` → `t("file", { count })`. Greek uses the same `_one` / `_other` suffixes.
- Keep product terms consistent in Greek: Plan → Σχέδιο, Approve → Έγκριση, Rule → Κανόνας, Trash → Κάδος, Undo → Αναίρεση, Needs Review → Προς έλεγχο, Space → Χώρος, Agent → Βοηθός.
- `src/i18n/locales.test.ts` fails if `en` and `el` keys differ or a value is empty.
