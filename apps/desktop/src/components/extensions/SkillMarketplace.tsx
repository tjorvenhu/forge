import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, PackageSearch, RefreshCw, Search, Trash2 } from "lucide-react";
import type { MarketplacePlugin } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner, LabelWithInfo } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { locale, t } from "@/i18n";

import { MARKETPLACE_LABEL, matchPlugins, type PluginShow as Show } from "./plugins";

const PLUGINS_KEY = ["plugins"] as const;
const m = t.extensions.marketplace;
/** more rows make typing in the search field sluggish; the search narrows it down */
const MAX_ROWS = 150;

/** Plugins from the Claude Code marketplaces; they bring their skills along. Installed globally. */
export function SkillMarketplace() {
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: PLUGINS_KEY, queryFn: () => call("plugins.catalog", {}), staleTime: 10 * 60_000 });
  const [query, setQuery] = useState("");
  const [marketplace, setMarketplace] = useState("all");
  const [show, setShow] = useState<Show>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<MarketplacePlugin | null>(null);

  const list = catalog.data;
  const marketplaces = useMemo(() => [...new Set((list ?? []).map((p) => p.marketplace))].sort(), [list]);
  const matches = useMemo(() => matchPlugins(list ?? [], query, marketplace, show), [list, query, marketplace, show]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(PLUGINS_KEY, await call("plugins.catalog", { refresh: true }));
    } catch (e) {
      toast.error(m.notRefreshed, errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (p: MarketplacePlugin) => {
    setBusy(p.id);
    try {
      qc.setQueryData(PLUGINS_KEY, await call("plugins.install", { id: p.id }));
      void qc.invalidateQueries({ queryKey: ["docs", "skill"] });
      toast.success(m.installed(p.name), m.installedHint);
    } catch (e) {
      toast.error(m.notInstalled(p.name), errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (p: MarketplacePlugin, enabled: boolean) => {
    setBusy(p.id);
    try {
      qc.setQueryData(PLUGINS_KEY, await call("plugins.setEnabled", { id: p.id, enabled }));
      void qc.invalidateQueries({ queryKey: ["docs", "skill"] });
      toast.success(enabled ? m.enabled(p.name) : m.disabled(p.name), m.newSessions);
    } catch (e) {
      toast.error(enabled ? m.notEnabled(p.name) : m.notDisabled(p.name), errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-4">
        <LabelWithInfo info={m.info}>
          <span className="text-xs text-muted">{m.intro}</span>
        </LabelWithInfo>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing} disabled={catalog.isLoading}>
          <RefreshCw className="h-3.5 w-3.5" /> {m.refresh}
        </Button>
      </div>

      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.searchPlaceholder} className="pl-8" aria-label={m.searchAria} autoFocus />
        </div>
        <Select<string>
          value={marketplace}
          onChange={setMarketplace}
          className="w-44"
          aria-label={m.marketplaceAria}
          options={[{ value: "all", label: m.allMarketplaces }, ...marketplaces.map((id) => ({ value: id, label: MARKETPLACE_LABEL[id] ?? id, description: id }))]}
        />
        <Select<Show>
          value={show}
          onChange={setShow}
          className="w-36"
          aria-label={m.showAria}
          options={[
            { value: "all", label: m.all },
            { value: "installed", label: m.installedFilter },
          ]}
        />
      </div>

      {catalog.isLoading && (
        <SkeletonRegion label={m.loading} className="divide-y divide-border rounded-lg border border-border">
          {[25, 35, 20, 30, 40, 25].map((w, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex h-5 items-center gap-1.5">
                  <Skeleton className="h-3" style={{ width: `${w}%` }} />
                  <Skeleton className="h-5 w-24 rounded" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
                <Skeleton className="h-2.5" style={{ width: `${w + 45}%` }} />
              </div>
              <Skeleton className="h-7 w-28 shrink-0" />
            </div>
          ))}
        </SkeletonRegion>
      )}
      {catalog.isError && <ErrorBanner title={m.notLoaded}>{errorMessage(catalog.error)}</ErrorBanner>}
      {list && matches.length === 0 && (
        <EmptyState icon={<PackageSearch className="h-8 w-8" />} title={show === "installed" && !query ? m.noneInstalled : m.noMatches} />
      )}
      <ul className={cn("divide-y divide-border rounded-lg border border-border", !matches.length && "hidden")} aria-label={m.listAria}>
        {matches.slice(0, MAX_ROWS).map((p) => (
          <li key={p.id} className="flex items-start gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-body">
                <span className="font-medium">{p.name}</span>
                <Badge>{MARKETPLACE_LABEL[p.marketplace] ?? p.marketplace}</Badge>
                {p.installed && <Badge tone={p.enabled === false ? "warning" : "success"}>{p.enabled === false ? m.badgeDisabled : m.badgeInstalled}</Badge>}
                {p.installCount !== null && <span className="text-caption tabular-nums text-subtle">{m.installs(p.installCount, p.installCount.toLocaleString(locale))}</span>}
              </div>
              {p.description && <p className="mt-0.5 line-clamp-2 text-caption text-muted">{p.description}</p>}
            </div>
            {p.installed ? (
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  checked={p.enabled !== false}
                  onChange={(v) => void setEnabled(p, v)}
                  label={p.enabled === false ? m.enable(p.name) : m.disable(p.name)}
                  disabled={busy !== null}
                />
                <Button size="sm" variant="danger-ghost" onClick={() => setRemoving(p)} disabled={busy !== null} aria-label={m.remove(p.name)}>
                  <Trash2 className="h-3.5 w-3.5" /> {m.removeButton}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void install(p)} loading={busy === p.id} disabled={busy !== null && busy !== p.id}>
                <Download className="h-3.5 w-3.5" /> {m.install}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {matches.length > MAX_ROWS && (
        <p className="mt-2 text-center text-xs text-subtle">
          {m.truncated(MAX_ROWS, matches.length.toLocaleString(locale))}
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={m.removeTitle(removing?.name ?? m.pluginFallback)}
        description={m.removeDescription}
        confirmLabel={m.removeConfirm}
        danger
        onConfirm={async () => {
          const p = removing;
          if (!p) return;
          setBusy(p.id);
          try {
            qc.setQueryData(PLUGINS_KEY, await call("plugins.uninstall", { id: p.id }));
            void qc.invalidateQueries({ queryKey: ["docs", "skill"] });
          } catch (e) {
            toast.error(m.notRemoved(p.name), errorMessage(e));
            throw e;
          } finally {
            setBusy(null);
          }
        }}
      />
    </section>
  );
}
