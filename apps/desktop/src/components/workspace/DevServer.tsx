import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play, RotateCw, SendHorizontal, Square } from "lucide-react";
import type { DevServerState, Project } from "@forge/protocol";
import { call, keys, useDevServer } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { activeDraftKey, useDrafts } from "@/stores/drafts";
import { useDevOutput } from "@/stores/dev-output";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";

/** Lines of dev server output handed to Claude; enough for a stack trace, small enough for the prompt. */
const LINES_FOR_CLAUDE = 80;

export function useDevActions(projectId: string) {
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

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
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

/** Output of the dev server (bottom panel and Dev-Tools tab), with a shortcut to hand the last lines to Claude. */
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
    const key = activeDraftKey(project.id, ui.activeSession[project.id]);
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
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-caption-lg leading-[1.45] text-muted"
      >
        {text || (state.effectiveCommand ? `Noch keine Ausgabe. Starten führt „${state.effectiveCommand}“ im Projektordner aus.` : "Kein Startbefehl erkannt. Trag ihn im Tab Dev-Tools ein.")}
      </pre>
    </div>
  );
}
