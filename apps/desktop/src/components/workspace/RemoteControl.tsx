import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Smartphone } from "lucide-react";
import type { Project, RemoteSession, RemoteState } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/misc";

/** Header button + dialog to continue all running FORGE sessions in the Claude app (Remote Control is global). */
export function RemoteControlButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const state = useQuery({ queryKey: keys.remote, queryFn: () => call("remote.state", {}) });
  const enabled = state.data?.enabled ?? false;
  const sessions = state.data?.sessions ?? [];
  const connected = sessions.some((s) => s.state === "connected");
  const dot = !enabled
    ? null
    : sessions.some((s) => s.state === "error")
      ? "bg-danger"
      : connected
        ? "bg-success"
        : sessions.length
          ? "bg-warning animate-soft-pulse"
          : "bg-muted";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn("relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-body hover:bg-surface-3 hover:text-fg", connected ? "text-success" : "text-muted")}
        title="In der Claude-App weiterarbeiten"
        aria-label="Remote-Steuerung"
      >
        <Smartphone className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">Remote</span>
        {dot && <span className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", dot)} />}
      </button>
      <RemoteDialog open={open} onOpenChange={setOpen} project={project} state={state.data ?? null} />
    </>
  );
}

const STATE_LABEL: Record<RemoteSession["state"], string> = { connected: "Verbunden", connecting: "Wird verbunden", error: "Fehler" };

function RemoteDialog({ open, onOpenChange, project, state }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; state: RemoteState | null }) {
  const qc = useQueryClient();
  const activeSession = useUi((s) => s.activeSession[project.id] ?? null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const enabled = state?.enabled ?? false;
  const sessions = [...(state?.sessions ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const connectedCount = sessions.filter((s) => s.state === "connected").length;
  const current =
    sessions.find((s) => s.sessionId === selected) ??
    sessions.find((s) => s.sessionId === activeSession) ??
    sessions.find((s) => s.projectId === project.id) ??
    sessions[0] ??
    null;

  const act = async (start: boolean) => {
    setBusy(true);
    try {
      qc.setQueryData(keys.remote, await call(start ? "remote.start" : "remote.stop", {}));
    } catch (e) {
      toast.error("Remote-Steuerung", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="In der Claude-App weiterarbeiten"
      description="Jede laufende FORGE-Session erscheint als eigener Eintrag in der Claude-App und auf claude.ai, aus allen Projekten. Nachrichten erscheinen auf beiden Seiten."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium">{enabled ? "Eingeschaltet" : "Aus"}</div>
            <div className="text-xs text-muted">
              {!enabled
                ? "Gilt für alle laufenden Sessions in FORGE"
                : sessions.length
                  ? `${connectedCount} von ${sessions.length} Session${sessions.length === 1 ? "" : "s"} verbunden`
                  : "Keine laufende Session"}
            </div>
          </div>
          {enabled ? (
            <Button variant="outline" onClick={() => void act(false)} loading={busy}>
              Ausschalten
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void act(true)} loading={busy}>
              Einschalten
            </Button>
          )}
        </div>

        {enabled && !sessions.length && (
          <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-body text-muted">
            Gerade läuft keine Session. FORGE startet dafür keine eigene. Sobald du eine Session startest oder fortsetzt, erscheint sie in der Claude-App.
          </p>
        )}

        {enabled && sessions.length > 0 && (
          <div className="flex flex-col gap-1">
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => setSelected(s.sessionId)}
                className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body hover:bg-surface-3", current?.sessionId === s.sessionId && "bg-surface-3")}
              >
                <StateDot state={s.state} />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted">{s.projectName}: </span>
                  {s.title || "Session"}
                </span>
                <span className={cn("shrink-0 text-xs", s.state === "error" ? "text-danger" : s.state === "connected" ? "text-success" : "text-muted")}>{STATE_LABEL[s.state]}</span>
              </button>
            ))}
          </div>
        )}

        {enabled && current && <SessionLink session={current} />}

        <p className="text-xs text-subtle">
          Sessions ohne laufenden Prozess erscheinen, sobald du sie fortsetzt. Eine beendete Session verschwindet aus der Liste. Ausschalten trennt alle Sessions, in FORGE laufen sie
          weiter. Freigaben und Sperrliste von FORGE gelten auch für Nachrichten aus der App. FORGE muss dafür geöffnet bleiben.
        </p>
      </div>
    </Dialog>
  );
}

function StateDot({ state }: { state: RemoteSession["state"] }) {
  return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", state === "connected" ? "bg-success" : state === "error" ? "bg-danger" : "bg-warning animate-soft-pulse")} />;
}

function SessionLink({ session }: { session: RemoteSession }) {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!session.url) return setQr(null);
    const css = getComputedStyle(document.documentElement);
    const url = session.url;
    const color = { dark: css.getPropertyValue("--color-fg").trim(), light: css.getPropertyValue("--color-surface").trim() };
    // qrcode loads only when a code is shown.
    void import("qrcode").then(({ default: QRCode }) => QRCode.toDataURL(url, { margin: 1, width: 220, color })).then(setQr);
  }, [session.url]);

  if (session.state === "error") return <ErrorBanner title="Verbindung fehlgeschlagen">{session.message ?? "Remote Control konnte nicht gestartet werden."}</ErrorBanner>;
  if (!session.url || session.state === "connecting") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="h-3.5 w-3.5" /> Verbindung zu claude.ai wird aufgebaut
      </div>
    );
  }
  return (
    <div className="flex items-start gap-4">
      {qr && <img src={qr} alt="QR-Code für die Claude-App" width={140} height={140} className="shrink-0 rounded-lg border border-border" />}
      <div className="flex min-w-0 flex-col gap-2 text-body">
        <div className="truncate font-medium" title={session.name}>
          {session.name}
        </div>
        <p className="text-muted">So heißt die Session in der Claude-App unter Code. Mit dem Handy scannen oder dort öffnen.</p>
        <div>
          <Button size="sm" onClick={() => void openExternal(session.url!)}>
            <ExternalLink className="h-3.5 w-3.5" /> Im Browser öffnen
          </Button>
        </div>
      </div>
    </div>
  );
}
