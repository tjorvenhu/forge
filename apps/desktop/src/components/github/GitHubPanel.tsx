import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, ExternalLink, Lock, LogOut, Search } from "lucide-react";
import { call, keys, useGitHubAccount, useGitHubLogin } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, ErrorBanner, SectionTitle, Spinner } from "@/components/ui/misc";

/** Sign in with GitHub inside FORGE (device flow via the shipped GitHub CLI) and list repositories. */
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

  if (account.isLoading) return <Spinner />;

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
            }
          }}
        />
      </div>
    );
  }

  if (state?.phase === "waiting" && state.code && state.url) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[13px] text-muted">Gib diesen Code auf der GitHub-Seite ein, die sich im Browser geöffnet hat:</p>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-2 font-mono text-2xl tracking-widest" aria-label="Einmal-Code">
            {state.code}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Code kopieren"
            onClick={() => void navigator.clipboard.writeText(state.code!).then(() => toast.success("Code kopiert"))}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void openExternal(state.url!)}>
            <ExternalLink className="h-3.5 w-3.5" /> GitHub öffnen
          </Button>
          <Button variant="ghost" onClick={() => void call("github.cancelLogin", {}).then((s) => qc.setQueryData(keys.githubLogin, s))}>
            Abbrechen
          </Button>
          <span className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> Warte auf Bestätigung
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-muted">
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

export function GitHubRepoList() {
  const account = useGitHubAccount();
  const setNewProject = useUi((s) => s.setNewProject);
  const [q, setQ] = useState("");
  const repos = useQuery({ queryKey: keys.githubRepos, queryFn: () => call("github.repos", {}), enabled: !!account.data, staleTime: 5 * 60_000 });
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !n || r.fullName.toLowerCase().includes(n) || (r.description ?? "").toLowerCase().includes(n));
  }, [repos.data, q]);

  if (!account.data) return null;
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle>Deine Repositories {repos.data ? `(${repos.data.length})` : ""}</SectionTitle>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Repository suchen" className="pl-8" aria-label="Repositories durchsuchen" />
      </div>
      {repos.isLoading && <Spinner />}
      {repos.isError && <ErrorBanner>{errorMessage(repos.error)}</ErrorBanner>}
      <div className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {filtered.map((r) => (
          <div key={r.fullName} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px]">
                <span className="truncate">{r.fullName}</span>
                {r.private && (
                  <Badge>
                    <Lock className="h-3 w-3" /> privat
                  </Badge>
                )}
              </div>
              <div className="truncate text-[11px] text-subtle">
                {r.description ? `${r.description} · ` : ""}aktualisiert {relativeTime(r.updatedAt)}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setNewProject("clone", r.cloneUrl)}>
              <Download className="h-3.5 w-3.5" /> Klonen
            </Button>
          </div>
        ))}
        {repos.isSuccess && filtered.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">Keine Treffer</div>}
      </div>
    </section>
  );
}
