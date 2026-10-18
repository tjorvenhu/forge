import { donations } from "@/lib/donations";

export const dynamic = "force-dynamic";

/** Donations so far (for the heart in the FORGE app); `donations: null` while the service has no Stripe key. */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ donations: await donations() }, { headers: { "Cache-Control": "public, max-age=600" } });
  } catch (err) {
    console.error("donations failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "stripe unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
