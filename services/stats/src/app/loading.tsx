import { StatsPage } from "@/components/stats-page";

export default function Loading() {
  // A placeholder for the donations only where they will show, so nothing jumps.
  return <StatsPage state={{ kind: "loading" }} donation={process.env.STRIPE_SECRET_KEY ? "loading" : undefined} />;
}
