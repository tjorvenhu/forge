import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play, RotateCw, ScrollText, SendHorizontal, Square } from "lucide-react";
import type { DevServerState, Project } from "@forge/protocol";
import { call, keys, useDevServer } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { draftKey, useDrafts } from "@/stores/drafts";
import { useDevOutput } from "@/stores/dev-output";
import { Button } from "@/components/ui/button";
import { Badge, Tooltip } from "@/components/ui/misc";
import { EXTERNAL_PREFIX } from "./ChatPanel";

/** Lines of dev server output handed to Claude; enough for a stack trace, small enough for the prompt. */
const LINES_FOR_CLAUDE = 80;

function useDevActions(projectId: string) {
  const qc = useQueryClient();
  const run = async (method: "devserver.start" | "devserver.stop", errorTitle: string) => {
    try {
      qc.setQueryData(keys.devServer(projectId), await call(method, { projectId }));
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
    }
  };
  return {
    start: () => {
      // A restart begins with an empty log, like a fresh terminal.
      useDevOutput.getState().set(projectId, "");
      return run("devserver.start", "Dev-Server nicht gestartet");
    },
    stop: () => run("devserver.stop", "Dev-Server nicht gestoppt"),
  };
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Start/stop and address of the dev server in the workspace header. */
export function DevServerButton({ project }: { project: Project }) {
  const state = useDevServer(project.id).data;
  const { start, stop } = useDevActions(project.id);
  const openLogs = () => useUi.getState().openPanelTab(project.id, "dev");
  if (!state) return null;

  if (state.status !== "running") {
    const crashed = (state.status === "exited" && state.exitCode !== 0 && state.exitCode !== null) || state.status === "failed";
    return (
      <div className="flex items-center gap-1">
        <Tooltip content={state.effectiveCommand ? `Dev-Server starten: ${state.effectiveCommand}` : "Kein Startbefehl erkannt. In den Projekt-Einstellungen eintragen."}>
          <button
            className={cn(
              "flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors",
              crashed ? "border-danger/30 bg-danger-soft text-danger" : "border-border text-muted hover:border-border-strong hover:text-fg",
            )}
            onClick={() => {
              if (!state.effectiveCommand) {
                useUi.getState().setWorkspaceTab("settings");
                toast.info("Startbefehl fehlt", "Trage unter Dev-Server-Befehl ein, wie das Projekt gestartet wird, z. B. pnpm dev.");
                return;
              }
              void start();
            }}
          >
            <Play className="h-3.5 w-3.5" /> {crashed ? "Dev-Server beendet" : "Dev-Server"}
          </button>
        </Tooltip>
        {crashed && (
          <Tooltip content="Der Dev-Server wurde unerwartet beendet. Ausgabe ansehen">
            <button onClick={openLogs} className="flex h-9 w-9 items-center justify-center rounded-lg text-danger hover:bg-surface-3" aria-label="Ausgabe des Dev-Servers ansehen">
              <ScrollText className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex h-9 items-center gap-1 rounded-lg border pl-3 pr-1 text-[13px]", state.url ? "border-success/30 bg-success-soft" : "border-warning/30 bg-warning-soft")}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", state.url ? "bg-success" : "animate-soft-pulse bg-warning")} aria-hidden />
      {state.url ? (
        <Tooltip content={`${state.url} im Browser öffnen`}>
          <button onClick={() => void openExternal(state.url!)} className="flex items-center gap-1.5 px-1 text-success hover:underline">
            Dev-Server online
            <span className="font-mono text-xs text-fg/70">{hostOf(state.url)}</span>
            <ExternalLink className="h-3 w-3" />
          </button>
        </Tooltip>
      ) : (
        <span className="px-1 text-warning">Dev-Server startet …</span>
      )}
      <Tooltip content="Ausgabe des Dev-Servers">
        <Button size="icon-sm" variant="ghost" onClick={openLogs} aria-label="Ausgabe des Dev-Servers">
          <ScrollText className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
      <Tooltip content="Dev-Server stoppen">
        <Button size="icon-sm" variant="ghost" onClick={() => void stop()} aria-label="Dev-Server stoppen" className="hover:text-danger">
          <Square className="h-3 w-3 fill-current" />
        </Button>
      </Tooltip>
    </div>
  );
}

function statusBadge(state: DevServerState) {
  switch (state.status) {
    case "running":
      return <Badge tone="success">läuft</Badge>;
    case "exited":
      return <Badge tone={state.exitCode === 0 ? "neutral" : "danger"}>beendet{state.exitCode !== null ? ` (Code ${state.exitCode})` : ""}</Badge>;
    case "failed":
      return <Badge tone="danger">Start fehlgeschlagen</Badge>;
    default:
      return <Badge>gestoppt</Badge>;
  }
}

/** Output of the dev server in the bottom panel, with a shortcut to hand the last lines to Claude. */
export function DevServerPanel({ project }: { project: Project }) {
  const state = useDevServer(project.id).data;
  const text = useDevOutput((s) => s.text[project.id]);
  const { start, stop } = useDevActions(project.id);
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (text !== undefined) return;
    call("devserver.output", { projectId: project.id })
      .then((r) => useDevOutput.getState().set(project.id, r.text))
      .catch(() => useDevOutput.getState().set(project.id, ""));
  }, [project.id, text]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const sendToClaude = () => {
    const lines = (text ?? "").trimEnd().split(/\r?\n/).slice(-LINES_FOR_CLAUDE).join("\n");
    if (!lines.trim()) return;
    const ui = useUi.getState();
    const active = ui.activeSession[project.id] ?? null;
    const key = active?.startsWith(EXTERNAL_PREFIX) ? draftKey(project.id, null, active.slice(EXTERNAL_PREFIX.length)) : draftKey(project.id, active);
    const block = `Ausgabe des Dev-Servers (${state?.command ?? "Dev-Server"}), letzte Zeilen:\n\n\`\`\`\n${lines}\n\`\`\`\n`;
    const drafts = useDrafts.getState();
    const cur = drafts.drafts[key]?.text ?? "";
    drafts.setText(key, cur.trim() ? `${cur.trimEnd()}\n\n${block}` : block);
    ui.setWorkspaceTab("chat");
    requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
    toast.info("In die Nachricht übernommen", "Schreib dazu, was Claude prüfen soll, und sende sie ab.");
  };

  if (!state) return null;
  const running = state.status === "running";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        {statusBadge(state)}
        <span className="min-w-0 truncate font-mono text-subtle">{state.command ?? state.effectiveCommand ?? "Kein Startbefehl"}</span>
        {running && state.url && (
          <button onClick={() => void openExternal(state.url!)} className="flex items-center gap-1 font-mono text-accent hover:underline">
            {hostOf(state.url)} <ExternalLink className="h-3 w-3" />
          </button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={sendToClaude} disabled={!text?.trim()} title="Die letzten Zeilen als Nachricht an Claude vorbereiten">
          <SendHorizontal className="h-3.5 w-3.5" /> An Claude
        </Button>
        {running ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => void stop().then(start)} title="Dev-Server neu starten">
              <RotateCw className="h-3.5 w-3.5" /> Neu starten
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void stop()} className="hover:text-danger">
              <Square className="h-3 w-3 fill-current" /> Stoppen
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void start()} disabled={!state.effectiveCommand}>
            <Play className="h-3.5 w-3.5" /> Starten
          </Button>
        )}
      </div>
      <pre
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] leading-[1.45] text-muted"
      >
        {text || (state.effectiveCommand ? `Noch keine Ausgabe. Starten führt „${state.effectiveCommand}“ im Projektordner aus.` : "Kein Startbefehl erkannt. Trage ihn in den Projekt-Einstellungen unter Dev-Server-Befehl ein.")}
      </pre>
    </div>
  );
}
