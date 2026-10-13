import type { ReactNode } from "react";
import { Activity, Anvil, BellRing, BookOpen, ChevronRight, GitBranchPlus, GitMerge, Send, ServerCog, Trash2, type LucideIcon } from "lucide-react";
import { Collapse } from "@/components/ui/collapse";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { cardKey, useCardState } from "@/stores/card-state";
import { useUi } from "@/stores/ui";
import { ChatRow, Guide } from "./ChatRow";
import { EVENT_ICON } from "./EventCard";
import { forgeTargetLabel, type ForgeTarget, type ForgeToolIcon, type ForgeToolView } from "./forge-tool";

const ICONS: Record<ForgeToolIcon, LucideIcon> = {
  knowledge: BookOpen,
  dev: ServerCog,
  notify: BellRing,
  agentStart: GitBranchPlus,
  agentStatus: Activity,
  agentMessage: Send,
  agentMerge: GitMerge,
  agentDiscard: Trash2,
  forge: Anvil,
};

export function forgeIcon(icon: ForgeToolIcon, className = EVENT_ICON) {
  const Icon = ICONS[icon];
  return <Icon className={className} />;
}

export type ForgeTone = ForgeToolView["tone"];

const ICON_TONE: Record<ForgeTone, string> = { accent: "text-accent", warning: "text-warning", danger: "text-danger" };
const CARD_TONE: Record<ForgeTone, string> = {
  accent: "border-accent/30 bg-accent-soft",
  warning: "border-warning/40 bg-warning-soft",
  danger: "border-danger/40 bg-danger-soft",
};

/**
 * A call of a FORGE tool: what FORGE did (saved to the knowledge, started an agent …) in words, with
 * its own icon and a way to the place where the result lives. Changes get a highlighted card, lookups
 * a quiet line; input and output stay one click away.
 */
export function ForgeToolCard({
  sessionId,
  itemKey,
  view,
  tone,
  stateLabel,
  pending,
  details,
  children,
}: {
  sessionId: string;
  itemKey: string;
  view: ForgeToolView;
  tone: ForgeTone;
  stateLabel: string;
  /** running or waiting for approval */
  pending: boolean;
  details: ReactNode;
  /** policy block and approval, below the card */
  children?: ReactNode;
}) {
  const [open, setOpen] = useCardState(cardKey(sessionId, itemKey, "open"), false);
  const openKnowledge = useUi((s) => s.openKnowledge);
  const openDevTools = useUi((s) => s.openDevTools);
  const setWorkspaceTab = useUi((s) => s.setWorkspaceTab);
  const go = (t: ForgeTarget) => (t.kind === "knowledge" ? openKnowledge(t.id) : t.kind === "devtools" ? openDevTools(t.section) : setWorkspaceTab(t.kind));

  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="group/tool flex min-w-0 flex-1 items-baseline gap-2 text-left transition-opacity duration-75 active:opacity-70"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`Details ${open ? "ausblenden" : "anzeigen"}`}
        >
          <span className="shrink-0 font-semibold text-fg">{view.title}</span>
          {view.ref && <span className="min-w-0 truncate text-small text-muted">{view.ref}</span>}
          <ChevronRight
            aria-hidden
            className={cn(
              "ml-auto h-3.5 w-3.5 shrink-0 self-center text-subtle transition group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100",
              open ? "rotate-90 opacity-100" : "opacity-0",
            )}
          />
        </button>
        {view.prominent && <span className="shrink-0 text-caption font-medium uppercase tracking-wide text-subtle">FORGE</span>}
        {view.target && !pending && (
          <Button size="sm" variant="ghost" className="-my-1 h-6 px-2" onClick={() => go(view.target!)}>
            {forgeTargetLabel(view.target)}
          </Button>
        )}
      </div>
      <Collapse open={open}>
        <Guide className="mt-1.5 space-y-2 pb-1">{details}</Guide>
      </Collapse>
    </>
  );

  return (
    <ChatRow
      className="text-body"
      // The card has 8px padding and a border above its first line.
      markerClassName={view.prominent ? "mt-2.25" : undefined}
      marker={
        <span role="img" aria-label={stateLabel} className={cn("flex", ICON_TONE[tone], pending && "animate-soft-pulse")}>
          {forgeIcon(view.icon)}
        </span>
      }
    >
      {view.prominent ? <div className={cn("rounded-md border px-3 py-2", CARD_TONE[tone])}>{body}</div> : body}
      {children}
    </ChatRow>
  );
}
