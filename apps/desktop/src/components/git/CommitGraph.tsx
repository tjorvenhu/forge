import { Fragment, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { Cloud, GitBranch, Tag } from "lucide-react";
import type { CommitInfo } from "@forge/protocol";
import { cn, relativeTime } from "@/lib/utils";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { layoutGraph, parseRefs, type GraphSegment, type GraphY } from "./graph-layout";
import { AuthorAvatar } from "./AuthorAvatar";

const LANE_COLORS = [
  { stroke: "stroke-accent", fill: "fill-accent" },
  { stroke: "stroke-graph-blue", fill: "fill-graph-blue" },
  { stroke: "stroke-success", fill: "fill-success" },
  { stroke: "stroke-graph-pink", fill: "fill-graph-pink" },
  { stroke: "stroke-warning", fill: "fill-warning" },
  { stroke: "stroke-graph-purple", fill: "fill-graph-purple" },
] as const;

const ROW_H = 46;
const HEADER_H = 30;
const LANE_W = 14;
const PAD = 12;

const x = (lane: number) => PAD + lane * LANE_W;
const y = (at: GraphY) => (at === "top" ? 0 : at === "mid" ? ROW_H / 2 : ROW_H);

function segmentPath(s: GraphSegment): string {
  const [x1, y1, x2, y2] = [x(s.fromLane), y(s.fromY), x(s.toLane), y(s.toY)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

const dayKey = (iso: string) => new Date(iso).toDateString();

/** "Heute", "Gestern", otherwise the weekday and date (with the year when it is not this year). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Heute";
  if (d.toDateString() === yesterday.toDateString()) return "Gestern";
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
}

/**
 * Commit history grouped by day, with lanes, refs and the current commit like the graph in VS Code.
 * Without `graph` (a filtered list, where lanes would be wrong) each commit gets a plain dot.
 */
export function CommitGraph({
  commits,
  avatars,
  localBranches,
  selected,
  onSelect,
  onContextMenu,
  graph = true,
  headHash,
}: {
  commits: CommitInfo[];
  /** from git.authorAvatars, by author email; may arrive after the commits */
  avatars: Readonly<Record<string, string | null>> | undefined;
  localBranches: ReadonlySet<string>;
  selected: string | null;
  onSelect: (hash: string) => void;
  onContextMenu?: (e: MouseEvent, commit: CommitInfo) => void;
  graph?: boolean;
  /** the checked-out commit; the log starts there, so a filtered list needs it passed */
  headHash: string | null;
}) {
  const layout = useMemo(() => layoutGraph(commits, LANE_COLORS.length), [commits]);
  const width = graph ? PAD * 2 + (layout.lanes - 1) * LANE_W : 24;
  const list = useRef<HTMLUListElement>(null);

  // A commit chosen elsewhere (search, a parent link) scrolls into view.
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector<HTMLElement>(`[data-hash="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = commits.findIndex((c) => c.hash === selected);
    const next = commits[Math.min(commits.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    onSelect(next.hash);
    list.current?.querySelector<HTMLElement>(`[data-hash="${next.hash}"]`)?.focus();
  };

  return (
    <ul ref={list} aria-label="Commit-Verlauf" className="px-2 pb-2" onKeyDown={onKeyDown}>
      {commits.map((c, i) => {
        const row = layout.rows[i]!;
        const lane = LANE_COLORS[row.color]!;
        const head = c.hash === headHash;
        const isSelected = selected === c.hash;
        const newDay = i === 0 || dayKey(commits[i - 1]!.date) !== dayKey(c.date);
        // Lanes running from the previous commit into this one pass through the day header.
        const through = i > 0 && graph ? layout.rows[i - 1]!.segments.filter((s) => s.toY === "bottom") : [];
        return (
          <Fragment key={c.hash}>
            {newDay && (
              <li aria-hidden className="flex items-center" style={{ height: HEADER_H }}>
                <svg width={width} height={HEADER_H} className="shrink-0 overflow-visible">
                  {through.map((s, k) => (
                    <path key={k} d={`M${x(s.toLane)} 0V${HEADER_H}`} className={cn("fill-none", LANE_COLORS[s.color]!.stroke)} strokeWidth={1.5} />
                  ))}
                </svg>
                <span className="pl-1 text-caption font-semibold uppercase tracking-wide text-subtle">{dayLabel(c.date)}</span>
              </li>
            )}
            <li>
              <button
                data-hash={c.hash}
                onClick={() => onSelect(c.hash)}
                onContextMenu={onContextMenu && ((e) => onContextMenu(e, c))}
                aria-current={isSelected ? "true" : undefined}
                title={`${c.subject}\n${c.shortHash} · ${c.author} · ${relativeTime(c.date)}`}
                className={cn(
                  "flex w-full items-center gap-1 rounded-md pr-3 text-left transition-colors duration-120 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
                  isSelected ? "bg-accent-soft ring-1 ring-inset ring-accent/40" : "hover:bg-surface-2",
                )}
                style={{ height: ROW_H }}
              >
                <svg width={width} height={ROW_H} className="shrink-0 overflow-visible" aria-hidden>
                  {graph ? (
                    <>
                      {row.segments.map((s, k) => (
                        <path key={k} d={segmentPath(s)} className={cn("fill-none", LANE_COLORS[s.color]!.stroke)} strokeWidth={1.5} />
                      ))}
                      {head ? (
                        <circle cx={x(row.lane)} cy={ROW_H / 2} r={5} className={cn("fill-bg", lane.stroke)} strokeWidth={2.5} />
                      ) : (
                        <circle cx={x(row.lane)} cy={ROW_H / 2} r={c.parents.length > 1 ? 3.5 : 4.5} className={lane.fill} />
                      )}
                    </>
                  ) : (
                    <circle cx={12} cy={ROW_H / 2} r={head ? 4.5 : 3.5} className={head ? "fill-accent" : "fill-border-strong"} />
                  )}
                </svg>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={cn("min-w-0 truncate text-body", head || isSelected ? "font-semibold" : "font-medium")}>{c.subject}</span>
                    <RefBadges refs={c.refs} localBranches={localBranches} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-caption text-subtle">
                    <AuthorAvatar name={c.author} url={c.avatarUrl ?? avatars?.[c.authorEmail]} className="h-4 w-4" />
                    <span className="truncate">{c.author}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{relativeTime(c.date)}</span>
                  </span>
                </span>
                <span className="shrink-0 pl-2 font-mono text-caption text-subtle">{c.shortHash}</span>
              </button>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

/** Two-line commit rows with the graph column, while the history loads. */
export function CommitListSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <SkeletonRegion label="Lädt Verlauf" className="px-2 pb-2">
      <div className="flex items-center" style={{ height: HEADER_H }}>
        <Skeleton className="ml-9 h-2.5 w-14 rounded-sm" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-1 pr-3" style={{ height: ROW_H }}>
          <div className="flex w-6 shrink-0 justify-center">
            <Skeleton className="h-2.5 w-2.5 rounded-full" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 pl-1">
            <Skeleton className="h-3 rounded-sm" style={{ width: `${45 + ((i * 37) % 40)}%` }} />
            <Skeleton className="h-2.5 w-32 rounded-sm" />
          </div>
          <Skeleton className="h-2.5 w-12 shrink-0 rounded-sm" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

export function RefBadges({ refs, localBranches }: { refs: readonly string[]; localBranches: ReadonlySet<string> }) {
  const parsed = parseRefs(refs, localBranches);
  if (!parsed.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {parsed.map((r) => (
        <span
          key={`${r.kind}:${r.name}`}
          // text-2xs stays outside cn: tailwind-merge takes it for a colour and drops it next to text-muted.
          className={`text-2xs ${cn(
            "inline-flex h-4.5 max-w-40 items-center gap-1 rounded-full border px-1.5",
            r.kind === "branch" && r.head ? "border-accent bg-accent text-accent-fg" : "border-border-strong text-muted",
          )}`}
          title={r.kind === "branch" ? (r.remote ? `${r.name}, auch auf dem Remote` : r.name) : r.kind === "tag" ? `Tag ${r.name}` : `Remote-Branch ${r.name}`}
        >
          {r.kind === "tag" ? <Tag className="h-2.5 w-2.5 shrink-0" /> : r.kind === "remote" ? <Cloud className="h-2.5 w-2.5 shrink-0" /> : <GitBranch className="h-2.5 w-2.5 shrink-0" />}
          <span className="truncate">{r.name}</span>
          {r.kind === "branch" && r.remote && <Cloud className="h-2.5 w-2.5 shrink-0" />}
        </span>
      ))}
    </span>
  );
}
