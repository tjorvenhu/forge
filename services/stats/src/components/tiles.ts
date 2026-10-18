import { ArrowDownToLine, ArrowUpFromLine, BadgeDollarSign, Bot, Clock, Coins, Database, DatabaseZap, FolderPlus, MessagesSquare, MonitorDown, Phone, Repeat, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Totals } from "@/lib/db";
import { ONLINE_MINUTES } from "@/lib/constants";
import { COUNTER_KEYS, type Counters } from "@/lib/report";
import { formatCount, formatHours, formatUsd } from "@/lib/format";
import { tokenSum } from "@/lib/history";

// Shared by the skeleton (server) and the live tiles (client), so it holds no hooks.

export type TileDef = {
  icon: LucideIcon;
  label: string;
  /** counted up from 0 on load and from the old value after a refresh */
  value: number;
  format: (n: number) => string;
  unit?: string;
  sub: string;
  highlight?: boolean;
  wide?: boolean;
  /** live indicator in front of the value: pulsing while anything is online */
  live?: boolean;
};

const usd = (cents: number) => `≈ ${formatUsd(cents)}`;

export function tiles(t: Totals): TileDef[] {
  const c = t.counters;
  const pricedTokens = Object.values(t.models).reduce((n, m) => n + m.tokens, 0);
  return [
    // Every token Claude processed through FORGE, whatever started it (sessions, agents, helper calls, phone), cache included.
    { icon: Coins, label: "Tokens gesamt", value: tokenSum(c), format: formatCount, sub: "alle Tokens über FORGE", highlight: true, wide: true },
    // Only calls the app recorded with their model and cost (newer app versions) are in it, see the note below the tiles.
    {
      icon: BadgeDollarSign,
      label: "Wert in API-Preisen",
      value: c.costUsdCents,
      format: usd,
      // Below 99 % the gap is worth a word; above, both numbers would read the same.
      sub: pricedTokens < tokenSum(c) * 0.99 ? `nur für ${formatCount(pricedTokens)} der ${formatCount(tokenSum(c))} Tokens bekannt` : "geschätzt nach API-Preisen",
      wide: true,
    },
    { icon: Clock, label: "Claude-Arbeitszeit", value: c.claudeWorkMs, format: formatHours, unit: "Std.", sub: "Laufzeit aller Durchläufe" },
    {
      icon: Repeat,
      label: "Durchläufe",
      value: c.claudeTurns,
      format: formatCount,
      sub: c.userTurns ? `${formatCount(c.userTurns)} von Nutzern gestartet` : "Aufträge an Claude",
    },
    { icon: MessagesSquare, label: "Sessions", value: c.sessions, format: formatCount, sub: "Chats mit Claude" },
    { icon: FolderPlus, label: "Projekte", value: c.projectsCreated, format: formatCount, sub: "in FORGE angelegt" },
    { icon: Bot, label: "Parallele Agenten", value: c.agentsStarted, format: formatCount, sub: `${formatCount(c.agentsMerged)} zusammengeführt` },
    { icon: Phone, label: "Telefonate", value: c.phoneCalls, format: formatCount, sub: "über die Telefon-Funktion" },
    { icon: MonitorDown, label: "Installationen", value: t.installs, format: formatCount, sub: `${formatCount(t.activeInstalls30d)} aktiv in 30 Tagen` },
    {
      icon: Wifi,
      label: "Gerade online",
      value: t.onlineInstalls,
      format: formatCount,
      sub: `Meldung in den letzten ${ONLINE_MINUTES} Min.`,
      live: t.onlineInstalls > 0,
    },
  ];
}

// Labels and icons of the tiles while the numbers load.
export const TILE_SHAPES = tiles({
  installs: 0,
  activeInstalls30d: 0,
  onlineInstalls: 0,
  counters: Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as Counters,
  updatedAt: new Date(0).toISOString(),
  models: {},
  versions: [],
  plans: [],
  history: [],
});

export const TOKEN_ROWS = [
  { key: "tokensInput", icon: ArrowUpFromLine, label: "Eingabe", description: "Text, den FORGE an Claude geschickt hat" },
  { key: "tokensOutput", icon: ArrowDownToLine, label: "Ausgabe", description: "Antworten und Werkzeugaufrufe von Claude" },
  { key: "tokensCacheRead", icon: Database, label: "Cache gelesen", description: "Aus dem Prompt-Cache, günstiger als neue Eingabe" },
  { key: "tokensCacheWrite", icon: DatabaseZap, label: "Cache geschrieben", description: "Neu in den Prompt-Cache gelegt" },
] as const;
