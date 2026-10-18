import type { ModelUsage } from "./report";

const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Readable name of a Claude model ID: "claude-opus-4-7" is "Opus 4.7", "claude-3-5-sonnet-20241022"
 * "Sonnet 3.5". "[1m]" (the same model with the 1M context window) is dropped, so both count as one model.
 * Provider prefixes (us.anthropic.) and suffixes (-v1:0) are ignored. Anything else stays as it is.
 */
export function modelLabel(id: string): string {
  const base = id.toLowerCase().replace(/\[1m\]$/, "");
  const fam = FAMILIES.join("|");
  // Version parts are one or two digits; an eight-digit part is the release date.
  const current = new RegExp(`(?:^|[.-])claude-(${fam})-(\\d{1,2})(?:-(\\d{1,2}))?(?=$|[-@:])`).exec(base);
  const legacy = new RegExp(`(?:^|[.-])claude-(\\d{1,2})(?:-(\\d{1,2}))?-(${fam})(?=$|[-@:])`).exec(base);
  let name: string | null = null;
  if (current) name = `${title(current[1]!)} ${current[2]}${current[3] ? `.${current[3]}` : ""}`;
  else if (legacy) name = `${title(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  return name ?? id;
}

export interface ModelRow extends ModelUsage {
  label: string;
}

/** Models summed by readable name (dated, undated and 1M IDs of one model become one row), most tokens first. */
export function groupModels(models: Record<string, ModelUsage>): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const [id, m] of Object.entries(models)) {
    const label = modelLabel(id);
    const row = rows.get(label) ?? { label, tokens: 0, costUsdCents: 0 };
    row.tokens += m.tokens;
    row.costUsdCents += m.costUsdCents;
    rows.set(label, row);
  }
  return [...rows.values()].filter((r) => r.tokens > 0 || r.costUsdCents > 0).sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}
