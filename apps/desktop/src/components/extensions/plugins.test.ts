import { describe, expect, it } from "vitest";
import type { MarketplacePlugin } from "@forge/protocol";
import { matchPlugins } from "./plugins";

const plugin = (id: string, description: string, installed = false): MarketplacePlugin => {
  const [name = id, marketplace = ""] = id.split("@");
  return { id, name, description, marketplace, installCount: null, installed, enabled: installed ? true : null };
};

const list = [
  plugin("frontend-design@claude-plugins-official", "Frontend design skill for UI work", true),
  plugin("playwright@claude-plugins-official", "Browser automation and testing"),
  plugin("seo-audit@anthropic-plugin-directory", "SEO audits for websites"),
];

describe("matchPlugins", () => {
  it("needs every search word in name or description", () => {
    expect(matchPlugins(list, "  browser TESTING ", "all", "all").map((p) => p.name)).toEqual(["playwright"]);
    expect(matchPlugins(list, "design", "all", "all").map((p) => p.name)).toEqual(["frontend-design"]);
    expect(matchPlugins(list, "", "all", "all")).toHaveLength(3);
  });

  it("filters by marketplace and installed state", () => {
    expect(matchPlugins(list, "", "anthropic-plugin-directory", "all").map((p) => p.name)).toEqual(["seo-audit"]);
    expect(matchPlugins(list, "", "all", "installed").map((p) => p.name)).toEqual(["frontend-design"]);
  });
});
