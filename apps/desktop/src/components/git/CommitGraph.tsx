import { useMemo } from "react";
import { Cloud, GitBranch, Tag } from "lucide-react";
import type { CommitInfo } from "@forge/protocol";
import { cn, relativeTime } from "@/lib/utils";
import { layoutGraph, parseRefs, type GraphSegment, type GraphY } from "./graph-layout";

const LANE_COLORS = [
  { stroke: "stroke-accent", fill: "fill-accent" },
  { stroke: "stroke-graph-blue", fill: "fill-graph-blue" },
  { stroke: "stroke-success", fill: "fill-success" },
  { stroke: "stroke-graph-pink", fill: "fill-graph-pink" },
  { stroke: "stroke-warning", fill: "fill-warning" },
  { stroke: "stroke-graph-purple", fill: "fill-graph-purple" },
] as const;

const ROW_H = 24;
const LANE_W = 12;
const PAD = 10;

const x = (lane: number) => PAD + lane * LANE_W;
const y = (at: GraphY) => (at === "top" ? 0 : at === "mid" ? ROW_H / 2 : ROW_H);

function segmentPath(s: GraphSegment): string {
  const [x1, y1, x2, y2] = [x(s.fromLane), y(s.fromY), x(s.toLane), y(s.toY)];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}

/** Commit history with lanes, refs and the current commit, like the graph in VS Code. */
export function CommitGraph({
  commits,
  localBranches,
  selected,
  onSelect,
}: {
  commits: CommitInfo[];
  localBranches: ReadonlySet<string>;
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  const layout = useMemo(() => layoutGraph(commits, LANE_COLORS.length), [commits]);
  const width = PAD * 2 + (layout.lanes - 1) * LANE_W;

  return (
    <ul aria-label="Commit-Verlauf" className="py-0.5">
      {commits.map((c, i) => {
        const row = layout.rows[i]!;
        const lane = LANE_COLORS[row.color]!;
        // The log starts at HEAD, so the first commit is the checked-out one.
        const head = i === 0;
        return (
          <li key={c.hash}>
            <button
              onClick={() => onSelect(c.hash)}
              aria-current={selected === c.hash ? "true" : undefined}
              title={`${c.subject}\n${c.shortHash} · ${c.author} · ${relativeTime(c.date)}`}
              className={cn("flex h-6 w-full items-center gap-1 pr-3 text-left text-small-lg", selected === c.hash ? "bg-surface-3" : "hover:bg-surface-2")}
            >
              <svg width={width} height={ROW_H} className="shrink-0 overflow-visible" aria-hidden>
                {row.segments.map((s, k) => (
                  <path key={k} d={segmentPath(s)} className={cn("fill-none", LANE_COLORS[s.color]!.stroke)} strokeWidth={1.5} />
                ))}
                {head ? (
                  <circle cx={x(row.lane)} cy={ROW_H / 2} r={4} className={cn("fill-bg", lane.stroke)} strokeWidth={2} />
                ) : (
                  <circle cx={x(row.lane)} cy={ROW_H / 2} r={c.parents.length > 1 ? 3 : 3.5} className={lane.fill} />
                )}
              </svg>
              <span className="min-w-0 flex-1 truncate">
                <span className={cn(head && "font-semibold")}>{c.subject}</span>
                <span className="ml-2 text-caption text-subtle">{c.author}</span>
              </span>
              <RefBadges refs={c.refs} localBranches={localBranches} />
            </button>
          </li>
        );
      })}
    </ul>
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
          className={cn(
            "inline-flex h-4.5 max-w-40 items-center gap-1 rounded-full border px-1.5 text-2xs",
            r.kind === "branch" && r.head ? "border-accent bg-accent text-accent-fg" : "border-border-strong text-muted",
          )}
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
