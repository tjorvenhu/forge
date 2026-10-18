import { StatsPage } from "@/components/stats-page";

export default function Loading() {
  return <StatsPage state={{ kind: "loading" }} />;
}
