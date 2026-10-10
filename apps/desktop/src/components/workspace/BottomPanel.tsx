import { useEffect, useState } from "react";
import { Bot, Play, Plus, SquareTerminal, X } from "lucide-react";
import type { Project } from "@forge/protocol";
import { useDiagnostics } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { OutputPanel } from "./OutputPanel";
import { TerminalView } from "./TerminalView";
import { DevServerPanel } from "./DevServer";

interface Tab {
  key: string;
  label: string;
  program: "shell" | "claude";
}

/**
 * Bottom panel: terminals for the project, the dev server output and the raw Claude event log.
 * Stays mounted while collapsed so running terminals keep their process.
 */
export function BottomPanel({ project }: { project: Project }) {
  const open = useUi((s) => s.bottomPanelOpen);
  const toggle = useUi((s) => s.toggleBottomPanel);
  const request = useUi((s) => s.terminalRequest);
  const clearRequest = useUi((s) => s.clearTerminalRequest);
  const panelRequest = useUi((s) => s.panelRequest);
  const clearPanelRequest = useUi((s) => s.clearPanelRequest);
  const diag = useDiagnostics();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("output");

  const add = (program: "shell" | "claude", label?: string) => {
    const key = crypto.randomUUID();
    setTabs((t) => [...t, { key, program, label: label ?? (program === "claude" ? "Claude" : `Terminal ${t.length + 1}`) }]);
    setActive(key);
    toggle(true);
  };

  useEffect(() => {
    if (request && request.projectId === project.id) {
      add(request.program, request.label);
      clearRequest();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to new requests only
  }, [request]);

  useEffect(() => {
    if (panelRequest && panelRequest.projectId === project.id) {
      setActive(panelRequest.tab);
      clearPanelRequest();
    }
  }, [panelRequest, project.id, clearPanelRequest]);

  const closeTab = (key: string) => {
    setTabs((t) => t.filter((x) => x.key !== key));
    if (active === key) setActive("output");
  };

  return (
    <div className={cn("flex h-64 shrink-0 flex-col border-t border-border bg-bg", !open && "hidden")}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 text-xs">
        {tabs.map((t) => (
          <div key={t.key} className={cn("flex items-center rounded", active === t.key ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
            <button className="flex items-center gap-1.5 px-2 py-1" onClick={() => setActive(t.key)}>
              {t.program === "claude" ? <Bot className="h-3.5 w-3.5" /> : <SquareTerminal className="h-3.5 w-3.5" />}
              {t.label}
            </button>
            <button className="pr-1.5 text-subtle hover:text-fg" aria-label={`${t.label} schließen`} onClick={() => closeTab(t.key)}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg" aria-label="Neues Terminal" title="Neues Terminal" onClick={() => add("shell")}>
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button className={cn("ml-2 flex items-center gap-1.5 rounded px-2 py-1", active === "dev" ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")} onClick={() => setActive("dev")}>
          <Play className="h-3 w-3" /> Dev-Server
        </button>
        <button className={cn("rounded px-2 py-1", active === "output" ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")} onClick={() => setActive("output")}>
          Claude Output
        </button>
        <div className="flex-1" />
        <button onClick={() => toggle(false)} className="rounded p-0.5 text-subtle hover:text-fg" aria-label="Panel schließen">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <div key={t.key} className={cn("absolute inset-0", active !== t.key && "invisible")}>
            <TerminalView cwd={project.path} program={t.program} claudePath={diag.data?.claude.path} />
          </div>
        ))}
        {active === "output" && (
          <div className="absolute inset-0">
            <OutputPanel projectId={project.id} embedded />
          </div>
        )}
        {active === "dev" && (
          <div className="absolute inset-0">
            <DevServerPanel project={project} />
          </div>
        )}
        {tabs.length === 0 && active !== "output" && active !== "dev" && <div className="p-3 text-xs text-subtle">Kein Terminal offen.</div>}
      </div>
    </div>
  );
}
