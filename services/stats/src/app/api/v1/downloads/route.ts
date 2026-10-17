import { installerDownloads } from "@/lib/downloads";

export const dynamic = "force-dynamic";

/** Downloads of the FORGE installer over all releases (for the README badge). */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ downloads: await installerDownloads() }, { headers: { "Cache-Control": "public, max-age=1800" } });
  } catch (err) {
    console.error("downloads failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "github unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
