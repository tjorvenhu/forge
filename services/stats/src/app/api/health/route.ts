import { ping } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  try {
    await ping();
    return new Response("ok", { headers });
  } catch (err) {
    console.error("health check failed:", err instanceof Error ? err.message : err);
    return new Response("database unavailable", { status: 503, headers });
  }
}
