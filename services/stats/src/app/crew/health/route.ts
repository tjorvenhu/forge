import { crewRelay } from "@/lib/crew-relay";

export const dynamic = "force-dynamic";

/** The crew relay runs (no database involved); rooms and open streams for a look at the load. */
export function GET(): Response {
  return Response.json({ ok: true, ...crewRelay().stats() }, { headers: { "cache-control": "no-store" } });
}
