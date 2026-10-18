import type { ForgeUsagePurpose } from "./models.js";
import { localeOf, pick, protocolLanguage } from "./i18n.js";

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

const TOKEN_UNITS = {
  en: { k: "k", m: "M", b: "B" },
  de: { k: "Tsd.", m: "Mio.", b: "Mrd." },
} as const;

/** A token count, short: 850, 12.4k, 3.2M (German: 12,4 Tsd., 3,2 Mio.). */
export function formatTokens(n: number): string {
  const lang = protocolLanguage();
  const units = TOKEN_UNITS[lang];
  const sep = lang === "de" ? " " : "";
  const num = (v: number) => v.toLocaleString(localeOf(lang), { maximumFractionDigits: v < 10 ? 1 : 0 });
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${num(n / 1000)}${sep}${units.k}`;
  if (n < 1_000_000_000) return `${num(n / 1_000_000)}${sep}${units.m}`;
  return `${num(n / 1_000_000_000)}${sep}${units.b}`;
}

const FORGE_USAGE_LABELS: Record<"en" | "de", Record<ForgeUsagePurpose, string>> = {
  en: {
    auto: "Messages sent by FORGE",
    commit: "Commit messages",
    title: "Session titles",
    summary: "Summaries",
    report: "Daily report",
    knowledge: "Project knowledge",
    pr: "Pull requests",
    changelog: "What's new",
    phone: "Phone",
    templates: "Learned templates",
    other: "Other",
  },
  de: {
    auto: "Von FORGE gesendete Nachrichten",
    commit: "Commit-Nachrichten",
    title: "Session-Titel",
    summary: "Zusammenfassungen",
    report: "Tagesbericht",
    knowledge: "Projektwissen",
    pr: "Pull Requests",
    changelog: "Neuerungen",
    phone: "Telefon",
    templates: "Gelernte Vorlagen",
    other: "Sonstiges",
  },
};

/** What FORGE had Claude do, for people. */
export function forgeUsageLabel(purpose: ForgeUsagePurpose): string {
  return pick(FORGE_USAGE_LABELS)[purpose];
}
