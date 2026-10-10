import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ExternalLink, Smartphone } from "lucide-react";
import type { Project, RemoteSession, RemoteState } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/misc";

export const remoteKey = (projectId: string) => ["remote", projectId] as const;

/** Header button + dialog to continue this project's sessions in the Claude app (Remote Control). */
export function RemoteControlButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const state = useQuery({ queryKey: remoteKey(project.id), queryFn: () => call("remote.state", { projectId: project.id }) });
  const enabled = state.data?.enabled ?? false;
  const sessions = state.data?.sessions ?? [];
  const connected = sessions.some((s) => s.state === "connected");
  const dot = !enabled ? null : sessions.some((s) => s.state === "error") ? "bg-danger" : connected ? "bg-success" : "bg-warning animate-soft-pulse";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn("relative flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-surface-3", connected ? "text-success" : "text-muted")}
        title="In der Claude-App weiterarbeiten"
        aria-label="Remote-Steuerung"
      >
        <Smartphone className="h-4 w-4" />
        {enabled && <span className="text-xs">Remote</span>}
        {dot && <span className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", dot)} />}
      </button>
      <RemoteDialog open={open} onOpenChange={setOpen} project={project} state={state.data ?? null} />
    </>
  );
}

function RemoteDialog({ open, onOpenChange, project, state }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; state: RemoteState | null }) {
  const qc = useQueryClient();
  const activeSession = useUi((s) => s.activeSession[project.id] ?? null);
  const setActiveSession = useUi((s) => s.setActiveSession);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const enabled = state?.enabled ?? false;
  const sessions = state?.sessions ?? [];
  const current = sessions.find((s) => s.sessionId === selected) ?? sessions.find((s) => s.sessionId === activeSession) ?? sessions[0] ?? null;

  const act = async (start: boolean) => {
    setBusy(true);
    try {
      const next = await call(start ? "remote.start" : "remote.stop", { projectId: project.id });
      qc.setQueryData(remoteKey(project.id), next);
      // FORGE opened an empty session for the app: show it in the chat as well.
      if (start && !activeSession && next.sessions[0]) setActiveSession(project.id, next.sessions[0].sessionId);
    } catch (e) {
      toast.error("Remote-Steuerung", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="In der Claude-App weiterarbeiten" description="Verbindet die Sessions dieses Projekts mit der Claude-App und claude.ai. Nachrichten erscheinen auf beiden Seiten.">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{enabled ? "Eingeschaltet" : "Aus"}</div>
            <div className="text-xs text-muted">{enabled ? `${sessions.length} Session${sessions.length === 1 ? "" : "s"} verbunden` : "Gilt für alle offenen Sessions dieses Projekts"}</div>
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

        {enabled && sessions.length > 1 && (
          <div className="flex flex-col gap-1">
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => setSelected(s.sessionId)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-3",
                  current?.sessionId === s.sessionId && "bg-surface-3",
                )}
              >
                <StateDot state={s.state} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </button>
            ))}
          </div>
        )}

        {enabled && current && <SessionLink session={current} />}

        <p className="text-xs text-subtle">
          Ohne offene Session startet FORGE eine leere, die du vom Handy aus beginnen kannst. Freigaben und Sperrliste von FORGE gelten auch für Nachrichten aus der App. FORGE muss dafür
          geöffnet bleiben.
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
    void QRCode.toDataURL(session.url, { margin: 1, width: 220, color: { dark: css.getPropertyValue("--color-fg").trim(), light: css.getPropertyValue("--color-surface").trim() } }).then(setQr);
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
      <div className="flex min-w-0 flex-col gap-2 text-[13px]">
        <div className="truncate font-medium">{session.title}</div>
        <p className="text-muted">Mit dem Handy scannen oder in der Claude-App unter Code öffnen.</p>
        <div>
          <Button size="sm" onClick={() => void openExternal(session.url!)}>
            <ExternalLink className="h-3.5 w-3.5" /> Im Browser öffnen
          </Button>
        </div>
      </div>
    </div>
  );
}
