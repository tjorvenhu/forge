import { Landing } from "@/components/landing";
import { getLocale } from "@/lib/locale-server";

// Language from cookie and header per request.
export const dynamic = "force-dynamic";

export default async function Home() {
  return <Landing locale={await getLocale()} />;
}
