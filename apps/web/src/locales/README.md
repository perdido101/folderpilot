# Locales

Every user-visible string lives here — never hard-code text in components. English only for now;
adding a language later means adding a sibling folder (e.g. `el/`) with the same files and registering it in `src/i18n/index.ts`.

- One JSON file per namespace (feature) in `en/`.
- Keys are camelCase, grouped by screen element: `{ "toolbar": { "rescan": "Rescan" } }`.
- Use from React: `const { t } = useTranslation("files"); t("toolbar.rescan")`.
- Keys from another namespace (typed!): load it too — `const { t } = useTranslation(["files", "common"]); t("common:actions.cancel")` — or pass `{ ns: "common" }`. A bare `t("common:…")` with only one namespace loaded fails the type-check.
- Outside React (stores, lib): `import i18n from "@/i18n"; i18n.t("moved", { ns: "actions", count })`.
- Interpolation: `"Moved {{count}} files"` → `t("moved", { count })`.
- Plurals: `"file_one": "{{count}} file", "file_other": "{{count}} files"` → `t("file", { count })`.
