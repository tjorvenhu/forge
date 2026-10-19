import type { Metadata } from "next";
import { getTotals } from "@/lib/db";
import { StatsPage, type PageState } from "@/components/stats-page";
import { getRoute } from "@/lib/locale-server";
import { jsonLdScript, pageMetadata, statsJsonLd } from "@/lib/seo";

// Rendered per request; getTotals() caches the sums for five minutes.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, base } = await getRoute();
  return pageMetadata("/stats", locale, base);
}

export default async function Stats() {
  let state: PageState;
  try {
    state = { kind: "ok", totals: await getTotals() };
  } catch (err) {
    console.error("totals failed:", err instanceof Error ? err.message : err);
    state = { kind: "error" };
  }
  const { locale, base } = await getRoute();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(statsJsonLd(locale, base)) }} />
      <StatsPage state={state} locale={locale} />
    </>
  );
}
