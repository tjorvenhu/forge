import { crewRelay } from "@/lib/crew-relay";
import { clientIp, hashIp } from "@/lib/new-install-limiter";
import { readBodyLimited } from "@/lib/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };

/** A sealed message of a FORGE crew into its room (see lib/crew-relay.ts). */
export async function POST(req: Request, ctx: RouteContext<"/crew/v1/rooms/[room]">): Promise<Response> {
  const relay = crewRelay();
  const { room } = await ctx.params;
  const raw = await readBodyLimited(req, relay.maxBodyBytes);
  // The limit counts per hashed address; the address itself is not kept.
  const reply = relay.post(room, raw, hashIp(clientIp(req.headers)));
  return Response.json(reply.body, { status: reply.status, headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } });
}
