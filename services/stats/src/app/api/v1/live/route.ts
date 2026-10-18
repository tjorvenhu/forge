import { getOnline } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return Response.json(
      { ...(await getOnline()), updatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=15" } },
    );
  } catch (err) {
    console.error("online failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "database unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
