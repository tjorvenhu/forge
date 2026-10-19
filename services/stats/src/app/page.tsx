import type { Metadata } from "next";
import { Landing } from "@/components/landing";
import { getRoute } from "@/lib/locale-server";
import { homeJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";

// Language from the path (/de, /en), else from cookie and header per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, base } = await getRoute();
  return pageMetadata("/", locale, base);
}

export default async function Home() {
  const { locale, base } = await getRoute();
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(homeJsonLd(locale, base)) }} />
      <Landing locale={locale} base={base} />
    </>
  );
}
