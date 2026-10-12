import { describe, expect, it } from "vitest";
import { layoutGraph, parseRefs } from "./graph-layout";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutGraph", () => {
  it("keeps a linear history on one lane", () => {
    const g = layoutGraph([c("c", "b"), c("b", "a"), c("a")], 6);
    expect(g.lanes).toBe(1);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // the tip has no line above its dot, the root none below
    expect(g.rows[0]!.segments).toEqual([{ fromLane: 0, fromY: "mid", toLane: 0, toY: "bottom", color: 0 }]);
    expect(g.rows[2]!.segments).toEqual([{ fromLane: 0, fromY: "top", toLane: 0, toY: "mid", color: 0 }]);
  });

  it("opens a lane for the second parent of a merge and closes it where both meet", () => {
    const g = layoutGraph([c("m", "a", "b"), c("a", "base"), c("b", "base"), c("base")], 6);
    expect(g.lanes).toBe(2);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(g.rows[0]!.segments).toContainEqual({ fromLane: 0, fromY: "mid", toLane: 1, toY: "bottom", color: 1 });
    // while "a" sits on lane 0, lane 1 runs through
    expect(g.rows[1]!.segments).toContainEqual({ fromLane: 1, fromY: "top", toLane: 1, toY: "bottom", color: 1 });
    // "b" joins lane 0, which already waits for "base"
    expect(g.rows[2]!.segments).toContainEqual({ fromLane: 1, fromY: "mid", toLane: 0, toY: "bottom", color: 0 });
    expect(g.rows[3]!.segments).toEqual([{ fromLane: 0, fromY: "top", toLane: 0, toY: "mid", color: 0 }]);
  });

  it("lets a parent outside the loaded range run to the bottom", () => {
    const g = layoutGraph([c("b", "a")], 6);
    expect(g.rows[0]!.segments).toEqual([{ fromLane: 0, fromY: "mid", toLane: 0, toY: "bottom", color: 0 }]);
  });

  it("cycles the colors through the palette", () => {
    const g = layoutGraph([c("m", "a", "b", "x"), c("a"), c("b"), c("x")], 2);
    expect(g.rows.map((r) => r.color)).toEqual([0, 0, 1, 0]);
  });
});

describe("parseRefs", () => {
  const local = new Set(["main", "feature/x"]);

  it("folds a remote branch in sync into its local badge", () => {
    expect(parseRefs(["HEAD -> main", "origin/main", "origin/HEAD"], local)).toEqual([{ kind: "branch", name: "main", head: true, remote: true }]);
  });

  it("keeps remote branches without a local one, tags and local branches with a slash", () => {
    expect(parseRefs(["feature/x", "origin/feature/y", "tag: v1.0"], local)).toEqual([
      { kind: "branch", name: "feature/x", head: false, remote: false },
      { kind: "tag", name: "v1.0" },
      { kind: "remote", name: "origin/feature/y" },
    ]);
  });

  it("drops the detached HEAD marker", () => {
    expect(parseRefs(["HEAD"], local)).toEqual([]);
  });
});
