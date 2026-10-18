import { getTotals } from "@/lib/db";
import { StatsPage, type PageState } from "@/components/stats-page";
import { getLocale } from "@/lib/locale-server";

// Rendered per request; getTotals() caches the sums for five minutes.
export const dynamic = "force-dynamic";

export default async function Home() {
  let state: PageState;
  try {
    state = { kind: "ok", totals: await getTotals() };
  } catch (err) {
    console.error("totals failed:", err instanceof Error ? err.message : err);
    state = { kind: "error" };
  }
  return <StatsPage state={state} locale={await getLocale()} />;
}
