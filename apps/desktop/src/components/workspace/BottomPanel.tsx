import { useEffect } from "react";
import { Bot, PanelBottomClose, Play, Plus, ScrollText, SquareTerminal, Users } from "lucide-react";
import type { Project } from "@forge/protocol";
import { useDiagnostics } from "@/lib/queries";
import { closeTerminal } from "@/lib/terminal-registry";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { DEFAULT_BOTTOM_TAB, NO_TABS, useTerminals, type TerminalProgram } from "@/stores/terminals";
import { Button } from "@/components/ui/button";
import { TabBar } from "@/components/ui/tabs";
import { OutputPanel } from "./OutputPanel";
import { TerminalView } from "./TerminalView";
import { t as tr } from "@/i18n";
import { DevServerPanel } from "./DevServer";

/**
 * Bottom panel: terminals for the project, the dev server output and the raw Claude event log.
 * Stays mounted while collapsed; terminal processes live in the terminal registry and keep running
 * when the project or the view changes.
 */
export function BottomPanel({ project }: { project: Project }) {
  const open = useUi((s) => s.bottomPanelOpen);
  const toggle = useUi((s) => s.toggleBottomPanel);
  const request = useUi((s) => s.terminalRequest);
  const clearRequest = useUi((s) => s.clearTerminalRequest);
  const panelRequest = useUi((s) => s.panelRequest);
  const clearPanelRequest = useUi((s) => s.clearPanelRequest);
  const diag = useDiagnostics();
  const tabs = useTerminals((s) => s.tabs[project.id] ?? NO_TABS);
  const active = useTerminals((s) => s.active[project.id] ?? DEFAULT_BOTTOM_TAB);
  const setActive = (tab: string) => useTerminals.getState().setActive(project.id, tab);

  const claudePath = diag.data?.claude.path ?? null;
  const diagLoading = diag.isLoading;
  useEffect(() => {
    if (!request || request.projectId !== project.id) return;
    // Claude tabs need the resolved binary; the request waits until diagnostics are there.
    if (request.program === "claude" && diagLoading) return;
    addTerminal(project, request.program, claudePath, request.label, { team: request.team, prompt: request.prompt });
    toggle(true);
    clearRequest();
  }, [request, project, diagLoading, claudePath, toggle, clearRequest]);

  useEffect(() => {
    if (panelRequest && panelRequest.projectId === project.id) {
      useTerminals.getState().setActive(project.id, panelRequest.tab);
      clearPanelRequest();
    }
  }, [panelRequest, project.id, clearPanelRequest]);

  const activeTerminal = tabs.find((t) => t.key === active);

  return (
    // Hidden, not unmounted (terminals keep running); the animation plays again each time it is shown.
    <div className={cn("flex h-64 shrink-0 animate-panel-up flex-col border-t border-border bg-bg", !open && "hidden")}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2">
        <TabBar<string>
          value={activeTerminal || active === "dev" ? active : "output"}
          onChange={setActive}
          tabs={[
            { value: "output", label: tr.workspace.bottomPanel.claudeOutput, icon: <ScrollText className="h-3.5 w-3.5" /> },
            { value: "dev", label: tr.workspace.bottomPanel.devServer, icon: <Play className="h-3 w-3" /> },
            ...tabs.map((t) => ({
              value: t.key,
              label: t.label,
              icon: t.team ? <Users className="h-3.5 w-3.5" /> : t.program === "claude" ? <Bot className="h-3.5 w-3.5" /> : <SquareTerminal className="h-3.5 w-3.5" />,
              onClose: () => {
                closeTerminal(t.key);
                useTerminals.getState().remove(project.id, t.key);
              },
              closeLabel: tr.workspace.bottomPanel.closeTab(t.label),
            })),
          ]}
        >
          <Button size="icon-sm" variant="ghost" aria-label={tr.workspace.bottomPanel.newTerminal} title={tr.workspace.bottomPanel.newTerminal} onClick={() => addTerminal(project, "shell", claudePath)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={tr.workspace.bottomPanel.newTeam}
            title={tr.workspace.bottomPanel.newTeamTitle}
            disabled={diagLoading || !claudePath}
            onClick={() => addTerminal(project, "claude", claudePath, undefined, { team: true })}
          >
            <Users className="h-3.5 w-3.5" />
          </Button>
        </TabBar>
        <div className="flex-1" />
        <Button size="icon-sm" variant="ghost" onClick={() => toggle(false)} aria-label={tr.workspace.bottomPanel.hide} title={tr.workspace.bottomPanel.hideTitle}>
          <PanelBottomClose className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <div key={t.key} className={cn("absolute inset-0", active !== t.key && "invisible")}>
            <TerminalView tab={t} />
          </div>
        ))}
        {!activeTerminal && active !== "dev" && (
          <div className="absolute inset-0">
            <OutputPanel projectId={project.id} embedded />
          </div>
        )}
        {active === "dev" && (
          <div className="absolute inset-0">
            <DevServerPanel project={project} />
          </div>
        )}
      </div>
    </div>
  );
}

function addTerminal(project: Project, program: TerminalProgram, claudePath: string | null, label?: string, opts?: { team?: boolean; prompt?: string | null }) {
  const claude = program === "claude";
  useTerminals.getState().add(project.id, { program, cwd: project.path, claudePath: claude ? claudePath : null, label, ...(claude && opts?.team ? { team: true, prompt: opts.prompt ?? null } : {}) });
}
