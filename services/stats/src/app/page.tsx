import { Suspense } from "react";
import { Landing, Numbers, NumbersSkeleton } from "@/components/landing";
import { getLocale } from "@/lib/locale-server";

// Language from cookie and header; the numbers stream in behind their skeleton.
export const dynamic = "force-dynamic";

export default async function Home() {
  const locale = await getLocale();
  return (
    <Landing
      locale={locale}
      numbers={
        <Suspense fallback={<NumbersSkeleton locale={locale} />}>
          <Numbers locale={locale} />
        </Suspense>
      }
    />
  );
}
