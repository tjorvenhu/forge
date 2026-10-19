import { Bot, Clock, Coins, FolderPlus, MessagesSquare, MonitorDown, Repeat, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Totals } from "@/lib/db";
import { ONLINE_MINUTES } from "@/lib/constants";
import { COUNTER_KEYS, type Counters } from "@/lib/report";
import { tokenSum } from "@/lib/history";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/messages";

// Shared by the skeleton (server) and the live grid (client), so it holds no hooks.

export type TileDef = {
  icon: LucideIcon;
  label: string;
  /** counted up from 0 on load and from the old value after a refresh */
  value: number;
  format: (n: number) => string;
  unit?: string;
  sub: string;
  /** live indicator in front of the value: pulsing while anything is online */
  live?: boolean;
};

export function tiles(t: Totals, locale: Locale): TileDef[] {
  const { t: m, f } = i18n(locale);
  const tt = m.stats.tiles;
  const c = t.counters;
  return [
    // Every token Claude processed through FORGE, whatever started it (sessions, agents, helper calls, phone), cache included.
    { icon: Coins, label: tt.tokens, value: tokenSum(c), format: f.count, sub: tt.tokensSub },
    { icon: MessagesSquare, label: tt.sessions, value: c.sessions, format: f.count, sub: tt.sessionsSub },
    { icon: Repeat, label: tt.turns, value: c.claudeTurns, format: f.count, sub: tt.turnsSub },
    { icon: Clock, label: tt.workTime, value: c.claudeWorkMs, format: f.hours, unit: tt.hoursUnit, sub: tt.workTimeSub },
    { icon: FolderPlus, label: tt.projects, value: c.projectsCreated, format: f.count, sub: tt.projectsSub },
    { icon: Bot, label: tt.agents, value: c.agentsStarted, format: f.count, sub: tt.agentsMerged(f.count(c.agentsMerged)) },
    { icon: MonitorDown, label: tt.installs, value: t.installs, format: f.count, sub: tt.installsActive(f.count(t.activeInstalls30d)) },
    { icon: Wifi, label: tt.online, value: t.onlineInstalls, format: f.count, sub: tt.onlineSub(ONLINE_MINUTES), live: t.onlineInstalls > 0 },
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
  history: [],
};

/** Labels and icons of the tiles while the numbers load. */
export const tileShapes = (locale: Locale) => tiles(ZERO, locale);
