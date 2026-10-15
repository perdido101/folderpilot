/**
 * Search (spec §11): words + meaning, natural queries ("invoices from Alpha 2025 pdf") turned into removable chips,
 * filters with counts. Folders on this device are searched in the browser; server spaces through the API (all spaces
 * of the organization, or one).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search, Sparkles, X } from "lucide-react";
import { Button, cn } from "@folderpilot/ui";
import { kindOf, removeChip, type FileKind, type QueryChip } from "@folderpilot/core";
import { api } from "@/lib/api";
import { browserProvider } from "@/lib/ai/provider";
import { deviceEmbedModel, hybridSearch, type DeviceSearch } from "@/lib/search";
import { useSettings } from "@/lib/settings";
import { formatDate } from "@/lib/format";
import { FileIcon } from "@/features/files/file-icon";
import { useActiveRoot, useRootFiles } from "@/hooks/use-active-root";
import { useActiveOrg, useServerSpaces } from "@/hooks/use-me";
import { useActiveServerSpace, type SpaceFile } from "@/features/server-space/api";
import { ServerQuickLook } from "@/features/server-space/server-quick-look";
import { useMode } from "@/stores/mode";
import { useSelection } from "@/stores/selection";
import { useUI } from "@/stores/ui";

const KINDS: FileKind[] = ["document", "image", "spreadsheet", "video", "audio", "archive", "code", "other"];
const FLAGS = ["duplicate", "near_duplicate", "blurry", "dark", "tiny", "screenshot", "suggested_delete"] as const;
const DATES = ["any", "7d", "30d", "thisYear", "lastYear"] as const;
const PAGE = 30;

/** "[[word]]" markers from the server/browser snippet → <mark>. */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-text">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function dateRange(key: (typeof DATES)[number], now = new Date()): { from?: string; to?: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = now.getUTCFullYear();
  switch (key) {
    case "7d":
      return { from: iso(new Date(now.getTime() - 7 * 86_400_000)) };
    case "30d":
      return { from: iso(new Date(now.getTime() - 30 * 86_400_000)) };
    case "thisYear":
      return { from: `${y}-01-01` };
    case "lastYear":
      return { from: `${y - 1}-01-01`, to: `${y}-01-01` };
    default:
      return {};
  }
}

interface Result {
  key: string;
  name: string;
  path: string;
  kind: FileKind;
  category: string | null;
  where: string;
  snippet: string | null;
  matchedBy: string[];
  mtime: number;
  open: () => void;
}

interface Facets {
  category: { key: string; count: number }[];
  kind: { key: string; count: number }[];
  space?: { key: string; name: string; count: number }[];
  client: { key: string; count: number }[];
}

/** Device snippet: a few words around the first match in the caption or text. */
function deviceSnippet(text: string | undefined, terms: string[]): string | null {
  if (!text || !terms.length) return null;
  const lower = text.toLowerCase();
  const term = terms.find((t) => lower.includes(t));
  if (!term) return null;
  const at = lower.indexOf(term);
  const start = Math.max(0, at - 60);
  const piece = text.slice(start, at + term.length + 80);
  const rel = at - start;
  return `${start ? "…" : ""}${piece.slice(0, rel)}[[${piece.slice(rel, rel + term.length)}]]${piece.slice(rel + term.length)}…`;
}

function countBy<T>(items: T[], key: (t: T) => string | null | undefined) {
  const m = new Map<string, number>();
  for (const i of items) {
    const k = key(i);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function SearchPage() {
  const { t } = useTranslation("search");
  const [params, setParams] = useSearchParams();
  const setSearch = useUI((s) => s.setSearch);
  const q = params.get("q") ?? "";
  const filter = {
    kind: params.get("kind") ?? "",
    category: params.get("category") ?? "",
    flag: params.get("flag") ?? "",
    client: params.get("client") ?? "",
    space: params.get("space") ?? "",
    date: (params.get("date") ?? "any") as (typeof DATES)[number],
  };
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [q, params]);

  // Debounce typing in the top bar.
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const dropChip = (chip: QueryChip) => {
    const nextQ = removeChip(q, chip);
    setSearch(nextQ);
    set("q", nextQ);
  };

  const mode = useMode((s) => s.mode);
  const serverSpace = useActiveServerSpace();
  const org = useActiveOrg();
  const root = useActiveRoot();
  // Signed in: search the organization's spaces unless a folder on this device is the one open.
  const useServer = mode === "account" && org && (serverSpace || !root);
  const more = () => setLimit((l) => l + PAGE);
  const view = useServer ? (
    <ServerResults orgId={org.id} q={debounced} filter={filter} limit={limit} onChip={dropChip} set={set} onMore={more} />
  ) : (
    <DeviceResults q={debounced} filter={filter} limit={limit} onChip={dropChip} set={set} onMore={more} />
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-4xl space-y-3">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-accent" />
          <h1 className="font-semibold">{q ? t("titleFor", { query: q }) : t("title")}</h1>
        </div>
        {view}
      </div>
    </div>
  );
}

interface ResultsProps {
  q: string;
  filter: { kind: string; category: string; flag: string; client: string; space: string; date: (typeof DATES)[number] };
  limit: number;
  onChip: (c: QueryChip) => void;
  set: (key: string, value: string) => void;
  onMore: () => void;
}

function DeviceResults({ q, filter, limit, onChip, set, onMore }: ResultsProps) {
  const { t } = useTranslation("search");
  const root = useActiveRoot();
  const files = useRootFiles(root?.id);
  const settings = useSettings();
  const openQuickLook = useSelection((s) => s.openQuickLook);
  const [res, setRes] = useState<DeviceSearch | null>(null);

  useEffect(() => {
    if (!root || !files) return;
    let live = true;
    const { from, to } = dateRange(filter.date);
    const scoped = files.filter(
      (f) =>
        f.status !== "trashed" &&
        (!filter.kind || f.kind === filter.kind) &&
        (!filter.category || f.category === filter.category) &&
        (!filter.flag || f.flags.includes(filter.flag as never)) &&
        (!filter.client || f.client === filter.client) &&
        (!from || f.mtime >= Date.parse(from)) &&
        (!to || f.mtime < Date.parse(to)),
    );
    void (async () => {
      const model = await deviceEmbedModel();
      const r = q.trim()
        ? await hybridSearch(root.id, scoped, q, { provider: browserProvider(settings.ai), ...(model ? { model } : {}) })
        : {
            hits: [...scoped].sort((a, b) => b.mtime - a.mtime).map((file) => ({ file, score: 0, sources: [] })),
            parsed: { terms: [], chips: [] },
            semantic: "unavailable" as const,
          };
      if (live) setRes(r);
    })();
    return () => {
      live = false;
    };
  }, [root, files, q, filter.kind, filter.category, filter.flag, filter.client, filter.date, settings.ai]);

  if (!root) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted">{t("noFolder")}</p>;
  if (!res) return null;
  const hits = res.hits;
  const ids = hits.map((h) => h.file.id);
  const results: Result[] = hits.slice(0, limit).map((h) => ({
    key: String(h.file.id),
    name: h.file.name,
    path: h.file.path,
    kind: h.file.kind,
    category: h.file.category ?? null,
    where: root.name,
    snippet: deviceSnippet(h.file.caption ?? h.file.textExcerpt, res.parsed.terms) ?? (h.file.caption ? h.file.caption : null),
    matchedBy: h.sources,
    mtime: h.file.mtime,
    open: () => openQuickLook(h.file.id, ids),
  }));
  const facets: Facets = {
    category: countBy(hits, (h) => h.file.category),
    kind: countBy(hits, (h) => h.file.kind),
    client: countBy(hits, (h) => h.file.client),
  };
  return (
    <ResultsView
      chips={res.parsed.chips}
      total={hits.length}
      semantic={res.semantic}
      results={results}
      facets={facets}
      filter={filter}
      set={set}
      onChip={onChip}
      onMore={onMore}
      hasMore={hits.length > limit}
    />
  );
}

interface ApiResult {
  file: SpaceFile;
  spaceName: string;
  matchedBy: string[];
  snippet: string | null;
}

function ServerResults({ orgId, q, filter, limit, onChip, set, onMore }: ResultsProps & { orgId: string }) {
  const { t } = useTranslation("search");
  const setActiveServerSpaceId = useUI((s) => s.setActiveServerSpaceId);
  const navigate = useNavigate();
  const spaces = useServerSpaces(orgId).data ?? [];
  const { from, to } = dateRange(filter.date);
  const qs = new URLSearchParams({ q, limit: String(limit), facets: "1" });
  for (const [k, v] of Object.entries({
    kind: filter.kind,
    category: filter.category,
    flag: filter.flag,
    client: filter.client,
    spaceId: filter.space,
    from: from ?? "",
    to: to ?? "",
  }))
    if (v) qs.set(k, v);
  const [looking, setLooking] = useState<{ file: SpaceFile; spaceName: string } | null>(null);
  const query = useQuery({
    queryKey: ["search", orgId, qs.toString()],
    queryFn: () => api<{ results: ApiResult[]; total: number; semantic: string; chips: QueryChip[]; facets: Facets }>(`/api/orgs/${orgId}/search?${qs}`),
    placeholderData: (prev) => prev,
  });
  if (query.isError) return <p className="text-sm text-danger">{(query.error as Error).message}</p>;
  const data = query.data;
  if (!data) return null;
  const results: Result[] = data.results.map((r) => ({
    key: r.file.id,
    name: r.file.name,
    path: r.file.path,
    kind: kindOf(r.file.ext),
    category: r.file.category,
    where: r.spaceName,
    snippet: r.snippet ?? r.file.caption,
    matchedBy: r.matchedBy,
    mtime: r.file.mtime,
    open: () => setLooking({ file: r.file, spaceName: r.spaceName }),
  }));
  return (
    <>
      <ServerQuickLook
        orgId={orgId}
        file={looking?.file ?? null}
        spaceName={looking?.spaceName}
        onClose={() => setLooking(null)}
        onShowInSpace={(f) => {
          setActiveServerSpaceId(f.spaceId);
          navigate(`/?q=${encodeURIComponent(f.name)}`);
        }}
      />
      <ResultsView
        chips={data.chips}
        total={data.total}
        semantic={data.semantic}
        results={results}
        facets={{ ...data.facets, space: data.facets.space?.length ? data.facets.space : spaces.map((s) => ({ key: s.id, name: s.name, count: 0 })) }}
        filter={filter}
        set={set}
        onChip={onChip}
        onMore={onMore}
        hasMore={data.total > results.length}
        loading={query.isFetching}
        emptyHint={t("emptyServer")}
      />
    </>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-8 rounded-lg border bg-surface px-2 text-xs", value && "border-accent text-accent")}
    >
      {children}
    </select>
  );
}

function ResultsView({
  chips,
  total,
  semantic,
  results,
  facets,
  filter,
  set,
  onChip,
  onMore,
  hasMore,
  loading,
  emptyHint,
}: {
  chips: QueryChip[];
  total: number;
  semantic: string;
  results: Result[];
  facets: Facets;
  filter: ResultsProps["filter"];
  set: ResultsProps["set"];
  onChip: ResultsProps["onChip"];
  onMore: () => void;
  hasMore: boolean;
  loading?: boolean;
  emptyHint?: string;
}) {
  const { t } = useTranslation(["search", "files"]);
  const navigate = useNavigate();
  const option = (key: string, count: number, label = key) => (
    <option key={key} value={key}>
      {label} ({count})
    </option>
  );
  const kindCounts = useMemo(() => new Map(facets.kind.map((k) => [k.key, k.count])), [facets.kind]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="search-chips">
        {chips.map((c) => (
          <span key={`${c.type}:${c.value}`} className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
            {t(`chips.${c.type}`, { value: t(`values.${c.value}`, { defaultValue: c.value.replace("..", " → ") }) })}
            <button onClick={() => onChip(c)} aria-label={t("removeChip", { chip: c.raw })} className="hover:text-text">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Select label={t("filters.type")} value={filter.kind} onChange={(v) => set("kind", v)}>
          <option value="">{t("filters.anyType")}</option>
          {KINDS.filter((k) => kindCounts.get(k) || filter.kind === k).map((k) => option(k, kindCounts.get(k) ?? 0, t(`values.${k}`)))}
        </Select>
        <Select label={t("filters.date")} value={filter.date === "any" ? "" : filter.date} onChange={(v) => set("date", v)}>
          {DATES.map((d) => (
            <option key={d} value={d === "any" ? "" : d}>
              {t(`dates.${d}`)}
            </option>
          ))}
        </Select>
        <Select label={t("filters.category")} value={filter.category} onChange={(v) => set("category", v)}>
          <option value="">{t("filters.anyCategory")}</option>
          {facets.category.map((c) => option(c.key, c.count))}
        </Select>
        {facets.space && (
          <Select label={t("filters.space")} value={filter.space} onChange={(v) => set("space", v)}>
            <option value="">{t("filters.anySpace")}</option>
            {facets.space.map((s) => option(s.key, s.count, s.name))}
          </Select>
        )}
        <Select label={t("filters.flag")} value={filter.flag} onChange={(v) => set("flag", v)}>
          <option value="">{t("filters.anyFlag")}</option>
          {FLAGS.map((f) => (
            <option key={f} value={f}>
              {t(`values.${f}`)}
            </option>
          ))}
        </Select>
        {facets.client.length > 0 && (
          <Select label={t("filters.client")} value={filter.client} onChange={(v) => set("client", v)}>
            <option value="">{t("filters.anyClient")}</option>
            {facets.client.map((c) => option(c.key, c.count))}
          </Select>
        )}
      </div>

      <p className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
        <span data-testid="search-total">{t("total", { count: total })}</span>
        <span>·</span>
        {semantic === "on" ? (
          <span className="inline-flex items-center gap-1 text-accent">
            <Sparkles className="size-3" /> {t("semantic.on")}
          </span>
        ) : semantic === "off" ? (
          <span>{t("semantic.off")}</span>
        ) : (
          <button className="underline hover:text-text" onClick={() => navigate("/settings")}>
            {semantic === "error" ? t("semantic.error") : t("semantic.unavailable")}
          </button>
        )}
        {loading && <span>· {t("searching")}</span>}
      </p>

      {results.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted">{emptyHint ?? t("empty")}</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-surface" data-testid="search-results">
          {results.map((r) => (
            <li key={r.key}>
              <button onClick={r.open} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2">
                <FileIcon kind={r.kind} className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{r.name}</span>
                    {r.category && <span className="rounded-full bg-surface-2 px-1.5 py-px text-[11px] font-normal text-muted">{r.category}</span>}
                    {r.matchedBy.includes("meaning") && (
                      <span
                        className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-normal text-accent"
                        title={t("byMeaningHint")}
                      >
                        <Sparkles className="size-3" /> {t("byMeaning")}
                      </span>
                    )}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted">
                    {r.where} · {r.path} · {formatDate(r.mtime)}
                  </p>
                  {r.snippet && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                      <Highlighted text={r.snippet} />
                    </p>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={onMore}>
            {t("more")}
          </Button>
        </div>
      )}
    </div>
  );
}
