import { StatsPage } from "@/components/stats-page";
import { getLocale } from "@/lib/locale-server";

export default async function Loading() {
  return <StatsPage state={{ kind: "loading" }} locale={await getLocale()} />;
}
