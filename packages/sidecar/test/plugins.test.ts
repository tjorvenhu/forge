import { describe, expect, it } from "vitest";
import { parsePluginList } from "../src/config/plugins.js";

describe("parsePluginList", () => {
  it("marks installed plugins, keeps ones missing from the catalog and sorts installed first", () => {
    const json = JSON.stringify({
      installed: [
        { id: "superpowers@claude-plugins-official", scope: "user", enabled: true },
        { id: "seo@other", scope: "user", enabled: false },
        { id: "local-only@claude-plugins-official", scope: "project", enabled: true },
      ],
      available: [
        { pluginId: "a@claude-plugins-official", name: "a", description: " A ", marketplaceName: "claude-plugins-official", installCount: 5 },
        { pluginId: "b@claude-plugins-official", name: "b", description: "B", marketplaceName: "claude-plugins-official", installCount: 50 },
        { pluginId: "superpowers@claude-plugins-official", name: "superpowers", description: "S", marketplaceName: "claude-plugins-official", installCount: 1 },
        { pluginId: "local-only@claude-plugins-official", name: "local-only", description: "L", marketplaceName: "claude-plugins-official" },
      ],
    });
    const list = parsePluginList(json);
    expect(list.map((p) => [p.id, p.installed, p.enabled])).toEqual([
      ["superpowers@claude-plugins-official", true, true],
      ["seo@other", true, false],
      ["b@claude-plugins-official", false, null],
      ["a@claude-plugins-official", false, null],
      ["local-only@claude-plugins-official", false, null],
    ]);
    expect(list.find((p) => p.id === "a@claude-plugins-official")?.description).toBe("A");
    expect(list.find((p) => p.id === "seo@other")).toMatchObject({ name: "seo", marketplace: "other", installCount: null });
  });

  it("rejects output that is not JSON", () => {
    expect(() => parsePluginList("Error: not logged in")).toThrow(/nicht lesbar/);
  });
});
