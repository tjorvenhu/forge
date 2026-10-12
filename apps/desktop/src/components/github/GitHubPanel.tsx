import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Lock, LogOut, Search } from "lucide-react";
import { call, keys, useGitHubAccount, useGitHubLogin } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, ErrorBanner, Loading } from "@/components/ui/misc";
import { DeviceCode } from "./DeviceCode";

/** Sign in with GitHub inside FORGE (device flow via the shipped GitHub CLI). */
export function GitHubAccountCard() {
  const account = useGitHubAccount();
  const login = useGitHubLogin();
  const qc = useQueryClient();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const state = login.data;
  const busy = state?.phase === "starting" || state?.phase === "waiting";

  const start = async () => {
    try {
      const s = await call("github.startLogin", {});
      qc.setQueryData(keys.githubLogin, s);
    } catch (e) {
      toast.error("Anmeldung nicht gestartet", errorMessage(e));
    }
  };

  if (account.isLoading) return <Loading />;

  if (account.data) {
    const a = account.data;
    return (
      <div className="flex items-center gap-3">
        {a.avatarUrl ? (
          <img src={a.avatarUrl} alt="" width={40} height={40} className="rounded-full border border-border" />
        ) : (
          <div className="h-10 w-10 rounded-full bg-surface-3" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{a.name ?? a.login}</div>
          <div className="text-xs text-muted">@{a.login}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void openExternal(a.profileUrl)}>
          <ExternalLink className="h-3.5 w-3.5" /> Profil
        </Button>
        <Button size="sm" variant="outline" onClick={() => setConfirmLogout(true)}>
          <LogOut className="h-3.5 w-3.5" /> Abmelden
        </Button>
        <ConfirmDialog
          open={confirmLogout}
          onOpenChange={setConfirmLogout}
          title="Von GitHub abmelden?"
          description="FORGE und git können danach nicht mehr auf deine privaten Repositories zugreifen, bis du dich erneut anmeldest."
          confirmLabel="Abmelden"
          danger
          onConfirm={async () => {
            try {
              await call("github.logout", {});
              await qc.invalidateQueries({ queryKey: keys.githubAccount });
              qc.removeQueries({ queryKey: keys.githubRepos });
            } catch (e) {
              toast.error("Abmelden fehlgeschlagen", errorMessage(e));
              throw e;
            }
          }}
        />
      </div>
    );
  }

  if (state?.phase === "waiting" && state.code && state.url) {
    return (
      <DeviceCode
        code={state.code}
        url={state.url}
        prompt="Gib diesen Code auf der GitHub-Seite ein, die sich im Browser geöffnet hat:"
        onCancel={() =>
          void call("github.cancelLogin", {})
            .then((s) => qc.setQueryData(keys.githubLogin, s))
            .catch((e: unknown) => toast.error("Abbrechen fehlgeschlagen", errorMessage(e)))
        }
      />
    );
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-body text-muted">
        Melde dich an, um private Repositories zu klonen, zu pushen und Pull Requests zu erstellen. Die Anmeldung läuft über GitHub im Browser; das Token liegt im
        Windows-Anmeldeinformationsspeicher, nicht in FORGE.
      </p>
      {state?.phase === "error" && <ErrorBanner title="Anmeldung fehlgeschlagen">{state.message}</ErrorBanner>}
      <Button variant="primary" onClick={() => void start()} loading={busy}>
        Mit GitHub anmelden
      </Button>
    </div>
  );
}

// Opens the browser as soon as the device code is known, once per login attempt.
let openedFor: string | null = null;
export function useAutoOpenGitHub() {
  const s = useGitHubLogin().data;
  const code = s?.phase === "waiting" ? s.code : null;
  const url = s?.url ?? null;
  useEffect(() => {
    if (code && url && openedFor !== code) {
      openedFor = code;
      void openExternal(url);
    }
  }, [code, url]);
}

/** The signed-in account's repositories, to pick one for cloning; nothing without a GitHub login. */
export function GitHubRepoPicker({ value, onPick }: { value: string; onPick: (cloneUrl: string) => void }) {
  const account = useGitHubAccount();
  const [q, setQ] = useState("");
  const repos = useQuery({ queryKey: keys.githubRepos, queryFn: () => call("github.repos", {}), enabled: !!account.data, staleTime: 5 * 60_000 });
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !n || r.fullName.toLowerCase().includes(n) || (r.description ?? "").toLowerCase().includes(n));
  }, [repos.data, q]);

  if (!account.data) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Repositories von ${account.data.login} durchsuchen`} className="pl-8" aria-label="Repositories durchsuchen" autoFocus />
      </div>
      {repos.isLoading && <Loading label="Repositories werden geladen …" />}
      {repos.isError && <ErrorBanner>{errorMessage(repos.error)}</ErrorBanner>}
      <div role="listbox" aria-label="Deine Repositories" className={cn("max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border", !repos.isSuccess && "hidden")}>
        {filtered.map((r) => {
          const selected = value === r.cloneUrl;
          return (
            <button
              key={r.fullName}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onPick(r.cloneUrl)}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-120", selected ? "bg-accent-soft" : "hover:bg-surface-2")}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-body">
                  <span className="truncate">{r.fullName}</span>
                  {r.private && (
                    <Badge>
                      <Lock className="h-3 w-3" /> privat
                    </Badge>
                  )}
                </div>
                <div className="truncate text-caption text-subtle">
                  {r.description ? `${r.description} · ` : ""}aktualisiert {relativeTime(r.updatedAt)}
                </div>
              </div>
              {selected && <Check className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          );
        })}
        {repos.isSuccess && filtered.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">Keine Treffer</div>}
      </div>
    </div>
  );
}
