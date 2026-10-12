import { describe, expect, it } from "vitest";
import type { ProjectWithStatus } from "@forge/protocol";
import { agentBusy, agentLabel, splitProjects } from "./project-tree";

const project = (id: string, o: Partial<ProjectWithStatus> = {}): ProjectWithStatus =>
  ({ id, name: id, path: `C:/${id}`, parentId: null, createdAt: "2026-10-01T00:00:00Z", git: null, lastSession: null, ...o }) as ProjectWithStatus;

describe("project tree", () => {
  it("puts agents under their project, newest first; orphans stay on their own", () => {
    const list = [
      project("shop"),
      project("a1", { parentId: "shop", lastSession: { id: "s", title: "alt", updatedAt: "2026-10-02T00:00:00Z", status: "idle" } }),
      project("a2", { parentId: "shop", lastSession: { id: "t", title: "neu", updatedAt: "2026-10-03T00:00:00Z", status: "running" } }),
      project("lonely", { parentId: "deleted" }),
    ];
    const { roots, agentsOf } = splitProjects(list);
    expect(roots.map((p) => p.id)).toEqual(["shop", "lonely"]);
    expect(agentsOf.get("shop")!.map((p) => p.id)).toEqual(["a2", "a1"]);
    expect(agentBusy(agentsOf.get("shop")![0]!)).toBe(true);
    expect(agentBusy(agentsOf.get("shop")![1]!)).toBe(false);
  });

  it("names an agent by its branch without the agent/ prefix", () => {
    expect(agentLabel(project("x", { git: { branch: "agent/csv-export-4y6f" } as ProjectWithStatus["git"] }))).toBe("csv-export-4y6f");
  });
});
