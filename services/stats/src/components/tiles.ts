import { CircleDollarSign, Clock, Coins, MessagesSquare, Repeat, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Totals } from "@/lib/db";
import { ONLINE_MINUTES } from "@/lib/constants";
import { COUNTER_KEYS, type Counters } from "@/lib/report";
import { tokenSum, type HistoryDay } from "@/lib/history";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/messages";

// Shared by the skeleton (server) and the live grid (client), so it holds no hooks.

/** Days in the small bar chart of a tile. */
export const SPARK_DAYS = 7;

export type TileDef = {
  icon: LucideIcon;
  label: string;
  /** counted up from 0 on load and from the old value after a refresh */
  value: number;
  format: (n: number) => string;
  unit?: string;
  sub: string;
  /** increments of the last SPARK_DAYS days, oldest first; null: the live dot instead */
  spark: number[] | null;
  /** orange bars; the others are gray, alternating like the mockup */
  sparkAccent: boolean;
  /** live dot at the right: pulsing while anything is online */
  live?: boolean;
};

export function tiles(t: Totals, locale: Locale): TileDef[] {
  const { t: m, f } = i18n(locale);
  const tt = m.stats.tiles;
  const c = t.counters;
  const days = t.history.slice(-SPARK_DAYS);
  const spark = (pick: (d: HistoryDay) => number) => days.map(pick);
  return [
    // Every token Claude processed through FORGE, whatever started it (sessions, agents, helper calls, phone), cache included.
    { icon: Coins, label: tt.tokens, value: tokenSum(c), format: f.count, sub: tt.tokensSub, spark: spark((d) => d.tokens), sparkAccent: true },
    { icon: MessagesSquare, label: tt.sessions, value: c.sessions, format: f.count, sub: tt.sessionsSub, spark: spark((d) => d.sessions), sparkAccent: false },
    { icon: Repeat, label: tt.turns, value: c.claudeTurns, format: f.count, sub: tt.turnsSub, spark: spark((d) => d.claudeTurns), sparkAccent: true },
    { icon: Clock, label: tt.workTime, value: c.claudeWorkMs, format: f.hours, unit: tt.hoursUnit, sub: tt.workTimeSub, spark: spark((d) => d.claudeWorkMs), sparkAccent: false },
    // The app sums what the SDK reports per run: the price of the tokens at API rates, also for subscriptions.
    { icon: CircleDollarSign, label: tt.cost, value: c.costUsdCents, format: f.usd, sub: tt.costSub, spark: spark((d) => d.costUsdCents), sparkAccent: true },
    { icon: Wifi, label: tt.online, value: t.onlineInstalls, format: f.count, sub: tt.onlineSub(ONLINE_MINUTES), spark: null, sparkAccent: false, live: t.onlineInstalls > 0 },
  ];
}

const ZERO: Totals = {
  installs: 0,
  activeInstalls30d: 0,
  onlineInstalls: 0,
  counters: Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as Counters,
  updatedAt: new Date(0).toISOString(),
  models: {},
  versions: [],
  plans: [],
  platforms: [],
  history: [],
};

/** Labels and icons of the tiles while the numbers load. */
export const tileShapes = (locale: Locale) => tiles(ZERO, locale);
