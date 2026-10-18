import type { MarketplacePlugin } from "@forge/protocol";
import { t } from "@/i18n";

export type PluginShow = "all" | "installed";

export const MARKETPLACE_LABEL: Record<string, string> = {
  "claude-plugins-official": "Anthropic",
  "anthropic-plugin-directory": t.extensions.marketplace.directory,
};

/** Every search word must appear in the name or description. */
export function matchPlugins(list: MarketplacePlugin[], query: string, marketplace: string, show: PluginShow): MarketplacePlugin[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((p) => {
    if (show === "installed" && !p.installed) return false;
    if (marketplace !== "all" && p.marketplace !== marketplace) return false;
    const text = `${p.name} ${p.description}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
