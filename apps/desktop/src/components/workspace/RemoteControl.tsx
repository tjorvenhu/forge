import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { ExternalLink, ShieldCheck, Smartphone } from "lucide-react";
import type { Project, RemoteState } from "@forge/protocol";
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

/** Header button + dialog to control this project from the Claude mobile app (Remote Control). */
export function RemoteControlButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const state = useQuery({ queryKey: remoteKey(project.id), queryFn: () => call("remote.state", { projectId: project.id }) });
  const phase = state.data?.phase ?? "off";
  const dot = phase === "connected" ? "bg-success" : phase === "starting" ? "bg-warning animate-soft-pulse" : phase === "error" || phase === "untrusted" ? "bg-danger" : null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn("relative flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-surface-3", phase === "connected" ? "text-success" : "text-muted")}
        title="Remote-Steuerung (Claude-App)"
        aria-label="Remote-Steuerung"
      >
        <Smartphone className="h-4 w-4" />
        {phase === "connected" && <span className="text-xs">Remote</span>}
        {dot && <span className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", dot)} />}
      </button>
      <RemoteDialog open={open} onOpenChange={setOpen} project={project} state={state.data ?? null} />
    </>
  );
}

function RemoteDialog({ open, onOpenChange, project, state }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project; state: RemoteState | null }) {
  const qc = useQueryClient();
  const openTerminal = useUi((s) => s.openTerminal);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const phase = state?.phase ?? "off";

  useEffect(() => {
    if (!state?.url) return setQr(null);
    const css = getComputedStyle(document.documentElement);
    void QRCode.toDataURL(state.url, { margin: 1, width: 220, color: { dark: css.getPropertyValue("--color-fg").trim(), light: css.getPropertyValue("--color-surface").trim() } }).then(setQr);
  }, [state?.url]);

  const act = async (start: boolean) => {
    setBusy(true);
    try {
      qc.setQueryData(remoteKey(project.id), await call(start ? "remote.start" : "remote.stop", { projectId: project.id }));
    } catch (e) {
      toast.error("Remote-Steuerung", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Vom Handy steuern" description="Remote Control von Claude Code: Sessions in diesem Projekt aus der Claude-App oder von claude.ai/code starten und steuern.">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">
              {phase === "connected" ? "Verbunden" : phase === "starting" ? "Verbinde …" : phase === "untrusted" ? "Ordner nicht freigegeben" : phase === "error" ? "Fehler" : "Aus"}
            </div>
            <div className="text-xs text-muted">{state?.detail ?? `Erscheint in der App als „FORGE · ${project.name}“`}</div>
          </div>
          {phase === "connected" || phase === "starting" ? (
            <Button variant="outline" onClick={() => void act(false)} loading={busy}>
              Ausschalten
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void act(true)} loading={busy}>
              Einschalten
            </Button>
          )}
        </div>

        {phase === "starting" && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" /> Verbindung zu claude.ai wird aufgebaut
          </div>
        )}

        {phase === "connected" && (
          <div className="flex items-start gap-4">
            {qr && <img src={qr} alt="QR-Code für die Claude-App" width={160} height={160} className="rounded-lg border border-border" />}
            <div className="flex flex-col gap-2 text-[13px]">
              <p className="text-muted">Mit dem Handy scannen oder in der Claude-App unter Code das Projekt wählen.</p>
              {state?.url && (
                <Button size="sm" onClick={() => void openExternal(state.url!)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Im Browser öffnen
                </Button>
              )}
            </div>
          </div>
        )}

        {phase === "untrusted" && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[13px] text-muted">
              Claude Code muss diesem Ordner einmal vertrauen. Öffne Claude im Terminal unten, bestätige die Frage „Do you trust the files in this folder?“ und schalte danach
              Remote erneut ein.
            </p>
            <Button
              onClick={() => {
                openTerminal(project.id, "claude", "Claude (Ordner freigeben)");
                onOpenChange(false);
              }}
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Ordner im Terminal freigeben
            </Button>
          </div>
        )}

        {phase === "error" && state?.message && <ErrorBanner>{state.message}</ErrorBanner>}

        <p className="text-xs text-subtle">
          Sessions, die du vom Handy startest, laufen über Claude Code direkt mit dem Permission-Modus deines Profils ({project.profile === "safe" ? "Freigaben nötig" : project.profile === "balanced" ? "Edits automatisch" : "Autonomous nur wenn freigeschaltet"}). Sie
          erscheinen in FORGE unter „Aus dem Terminal“. Die FORGE-Sperrliste gilt für diese Sessions nicht.
        </p>
      </div>
    </Dialog>
  );
}
