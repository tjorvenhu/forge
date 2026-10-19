import type { Metadata } from "next";
import { getTotals } from "@/lib/db";
import { StatsPage, type PageState } from "@/components/stats-page";
import { getLocale } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";

// Rendered per request; getTotals() caches the sums for five minutes.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = i18n(await getLocale());
  return { title: t.statsMeta.title, description: t.statsMeta.description };
}

export default async function Stats() {
  let state: PageState;
  try {
    state = { kind: "ok", totals: await getTotals() };
  } catch (err) {
    console.error("totals failed:", err instanceof Error ? err.message : err);
    state = { kind: "error" };
  }
  return <StatsPage state={state} locale={await getLocale()} />;
}
