import { deleteInstall } from "@/lib/db";
import { installIdSchema } from "@/lib/report";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: RouteContext<"/api/v1/report/[installId]">): Promise<Response> {
  const parsed = installIdSchema.safeParse((await ctx.params).installId);
  if (!parsed.success) return Response.json({ error: "invalid installId" }, { status: 400 });
  try {
    await deleteInstall(parsed.data);
  } catch (err) {
    console.error("delete failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "database unavailable" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
