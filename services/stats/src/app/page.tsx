import { getTotals } from "@/lib/db";
import { donations } from "@/lib/donations";
import { StatsPage, type PageState } from "@/components/stats-page";

// Rendered per request; getTotals() caches the sums for five minutes, donations() for ten.
export const dynamic = "force-dynamic";

export default async function Home() {
  const [totals, donated] = await Promise.allSettled([getTotals(), donations()]);
  let state: PageState;
  if (totals.status === "fulfilled") state = { kind: "ok", totals: totals.value };
  else {
    console.error("totals failed:", totals.reason instanceof Error ? totals.reason.message : totals.reason);
    state = { kind: "error" };
  }
  // Without a Stripe key or when Stripe fails the figure is left out; the rest of the page stands.
  if (donated.status === "rejected") console.error("donations failed:", donated.reason instanceof Error ? donated.reason.message : donated.reason);
  return <StatsPage state={state} donation={donated.status === "fulfilled" ? (donated.value ?? undefined) : undefined} />;
}
