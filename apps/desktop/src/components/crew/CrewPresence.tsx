import { useCrew } from "@/lib/queries";
import { openCrew } from "@/lib/crew";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/misc";
import { MemberAvatar } from "./CrewDialogs";
import { t } from "@/i18n";

const m = t.crew;
/** avatars shown in the header; the rest is a number */
const MAX = 4;

/**
 * The project's crew in the workspace header: one avatar per member (online dot, agents in the
 * tooltip), a mark for open join requests. A click opens the Crew tab. Nothing without a crew.
 */
export function CrewPresence({ projectId }: { projectId: string }) {
  const { crew } = useCrew(projectId);
  if (!crew || crew.membership !== "member") return null;
  const shown = crew.members.slice(0, MAX);
  const working = crew.members.reduce((n, x) => n + x.agents.filter((a) => a.status === "working").length, 0);
  const tip = crew.members
    .map((x) =>
      m.presenceMember(
        x.self ? `${x.name} (${m.you})` : x.name,
        x.online,
        x.agents.map((a) => m.presenceAgent(a.title, m.agentStatus[a.status])).join("\n"),
      ),
    )
    .join("\n");
  return (
    <Tooltip content={<span className="whitespace-pre-line">{`${crew.name}\n${tip}`}</span>}>
      <button
        type="button"
        onClick={() => openCrew(crew.projectId)}
        aria-label={m.presenceTitle(crew.name)}
        className="relative flex shrink-0 items-center rounded-full px-1 py-0.5 transition-colors duration-120 hover:bg-surface-3"
      >
        {/* Stacked: a status dot would cover the next avatar, so offline members are only dimmed. */}
        <span className="flex -space-x-1">
          {shown.map((x) => (
            <MemberAvatar key={x.id} name={x.name} color={x.color} size={22} className={cn("ring-2 ring-bg", !x.online && "opacity-45")} />
          ))}
        </span>
        {crew.members.length > MAX && <span className="ml-1 text-xs text-muted">+{crew.members.length - MAX}</span>}
        {working > 0 && <span className="ml-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />}
        {crew.requests.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-accent-fg">
            {crew.requests.length}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** Badge of the Crew tab: open join requests, otherwise how many others are online. */
export function CrewTabBadge({ projectId }: { projectId: string }) {
  const { crew } = useCrew(projectId);
  if (!crew || crew.membership !== "member") return null;
  if (crew.requests.length) return <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">{crew.requests.length}</span>;
  const online = crew.members.filter((x) => !x.self && x.online).length;
  return online ? <span className="h-1.5 w-1.5 rounded-full bg-success" title={String(online)} aria-hidden /> : null;
}
