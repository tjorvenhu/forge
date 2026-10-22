import { crewRelay, STREAM_HEADERS } from "@/lib/crew-relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent events of a crew's room: kept messages after `after`, then `ready`, then live. */
export async function GET(req: Request, ctx: RouteContext<"/crew/v1/rooms/[room]/stream">): Promise<Response> {
  const { room } = await ctx.params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();
  let stop: (() => void) | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => {
        if (closed) return;
        closed = true;
        stop?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };
      const sub = crewRelay().subscribe(room, after, {
        write: (chunk) => {
          if (!closed) controller.enqueue(encoder.encode(chunk));
        },
        close: end,
      });
      if ("status" in sub) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(sub.body)}\n\n`));
        end();
        return;
      }
      stop = sub.stop;
      req.signal.addEventListener("abort", end);
    },
    cancel() {
      closed = true;
      stop?.();
    },
  });
  return new Response(stream, { headers: STREAM_HEADERS });
}
