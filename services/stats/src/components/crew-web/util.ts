"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { intlLocale, type Locale } from "@/lib/i18n";
import { CrewWebError, type CrewView, type CrewWebClient } from "@/lib/crew-web/client";
import type { CrewMessages } from "@/lib/crew-web/messages";

/** The crew as it is now; renders again when anything in it changes. */
export function useCrew(client: CrewWebClient): CrewView {
  return useSyncExternalStore(
    (fn) => client.subscribe(fn),
    () => client.view(),
    () => client.view(),
  );
}

/** A value that changes every `ms`, so relative times and "online" stay current. */
export function useTick(ms = 20_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function relativeTime(iso: string, locale: Locale, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86_400), "day");
}

export function clock(iso: string, locale: Locale): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(intlLocale(locale), sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : (parts[0]?.[1] ?? ""))).toUpperCase();
}

export function errorText(e: unknown, m: CrewMessages): string {
  if (e instanceof CrewWebError) return m.errors[e.code];
  return m.errors.generic;
}
