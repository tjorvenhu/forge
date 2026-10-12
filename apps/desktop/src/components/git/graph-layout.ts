/** Where a line of the graph starts or ends inside a row: top edge, the commit dot, or bottom edge. */
export type GraphY = "top" | "mid" | "bottom";

export interface GraphSegment {
  fromLane: number;
  fromY: GraphY;
  toLane: number;
  toY: GraphY;
  color: number;
}

export interface GraphRow {
  /** lane of the commit dot */
  lane: number;
  color: number;
  segments: GraphSegment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** widest row, for a graph column that keeps the subjects aligned */
  lanes: number;
}

/**
 * Lays out commits (newest first, topological order) on lanes, like the graph in VS Code or git log
 * --graph. Each lane waits for one commit hash; a commit takes the lane that waits for it and hands it
 * to its first parent, further parents of a merge get lanes of their own. Lanes whose parent is outside
 * the loaded range simply run to the bottom.
 */
export function layoutGraph(commits: ReadonlyArray<{ hash: string; parents: readonly string[] }>, palette: number): GraphLayout {
  const lanes: Array<string | null> = [];
  const colors: number[] = [];
  let nextColor = 0;
  let width = 0;
  const freeLane = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  const rows = commits.map((c) => {
    const segments: GraphSegment[] = [];
    let lane = lanes.indexOf(c.hash);
    const continued = lane !== -1;
    if (!continued) {
      lane = freeLane();
      lanes[lane] = c.hash;
      colors[lane] = nextColor++ % palette;
    }
    const color = colors[lane]!;
    const top = lanes.slice();

    // Every lane that waited for this commit ends in its dot (several when branches meet here).
    top.forEach((h, j) => {
      if (h !== c.hash || (j === lane && !continued)) return;
      segments.push({ fromLane: j, fromY: "top", toLane: lane, toY: "mid", color: colors[j]! });
      if (j !== lane) lanes[j] = null;
    });

    const [first, ...rest] = c.parents;
    if (first === undefined) {
      lanes[lane] = null;
    } else {
      const other = lanes.indexOf(first);
      if (other !== -1 && other !== lane) {
        // The first parent is already on another lane: join it there.
        lanes[lane] = null;
        segments.push({ fromLane: lane, fromY: "mid", toLane: other, toY: "bottom", color: colors[other]! });
      } else {
        lanes[lane] = first;
        segments.push({ fromLane: lane, fromY: "mid", toLane: lane, toY: "bottom", color });
      }
    }
    for (const p of rest) {
      let k = lanes.indexOf(p);
      if (k === -1) {
        k = freeLane();
        lanes[k] = p;
        colors[k] = nextColor++ % palette;
      }
      segments.push({ fromLane: lane, fromY: "mid", toLane: k, toY: "bottom", color: colors[k]! });
    }

    // Lanes waiting for other commits pass straight through.
    top.forEach((h, j) => {
      if (h !== null && h !== c.hash && lanes[j] === h) segments.push({ fromLane: j, fromY: "top", toLane: j, toY: "bottom", color: colors[j]! });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }
    width = Math.max(width, top.length, lanes.length, lane + 1);
    return { lane, color, segments };
  });

  return { rows, lanes: width };
}

export type GraphRef = { kind: "branch"; name: string; head: boolean; remote: boolean } | { kind: "remote" | "tag"; name: string };

/**
 * Turns git's decorations into badges. A remote branch on the same commit as its local branch is shown
 * as a cloud on the local badge (in sync), not as a badge of its own.
 */
export function parseRefs(refs: readonly string[], localBranches: ReadonlySet<string>): GraphRef[] {
  const names = refs.map((r) => (r.startsWith("HEAD -> ") ? { name: r.slice(8), head: true } : { name: r, head: false }));
  // "HEAD" alone marks a detached HEAD; the graph shows that on the dot, not as a badge.
  const isLocal = (n: { name: string; head: boolean }) =>
    n.head || localBranches.has(n.name) || (n.name !== "HEAD" && !n.name.includes("/") && !n.name.startsWith("tag: "));
  const local = new Set(names.filter(isLocal).map((n) => n.name));
  const remotes = names.filter((n) => !isLocal(n) && !n.name.startsWith("tag: ") && n.name !== "HEAD" && !n.name.endsWith("/HEAD")).map((n) => n.name);
  const tracked = (r: string) => local.has(r.slice(r.indexOf("/") + 1));

  const out: GraphRef[] = [];
  for (const n of names) {
    if (n.name.startsWith("tag: ")) out.push({ kind: "tag", name: n.name.slice(5) });
    else if (isLocal(n)) out.push({ kind: "branch", name: n.name, head: n.head, remote: remotes.some((r) => r.slice(r.indexOf("/") + 1) === n.name) });
  }
  for (const r of remotes) if (!tracked(r)) out.push({ kind: "remote", name: r });
  return out;
}
