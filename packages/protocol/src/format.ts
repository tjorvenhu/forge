import type { ForgeUsagePurpose } from "./models.js";

/** A working time for people: 45 s, 12 min, 5 h 20 min. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s === 0) return "0 min";
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A token count, short: 850, 12,4 Tsd., 3,2 Mio. */
export function formatTokens(n: number): string {
  const de = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 });
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${de(n / 1000)} Tsd.`;
  if (n < 1_000_000_000) return `${de(n / 1_000_000)} Mio.`;
  return `${de(n / 1_000_000_000)} Mrd.`;
}

/** What FORGE had Claude do, for people. */
export const FORGE_USAGE_LABEL: Record<ForgeUsagePurpose, string> = {
  auto: "Von FORGE gesendete Nachrichten",
  commit: "Commit-Nachrichten",
  title: "Session-Titel",
  summary: "Zusammenfassungen",
  report: "Tagesbericht",
  knowledge: "Projektwissen",
  pr: "Pull Requests",
  changelog: "Neuerungen",
  phone: "Telefon",
  other: "Sonstiges",
};
