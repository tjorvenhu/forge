import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DownloadPage } from "@/components/download";
import { DOWNLOAD_URL } from "@/lib/constants";
import { detectOs, latestBuilds, type Builds, type Os } from "@/lib/builds";
import { getRoute } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";
import { SITE_URL } from "@/lib/seo";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRoute();
  const d = i18n(locale).t.download;
  return { title: d.metaTitle, description: d.metaDescription, alternates: { canonical: `${SITE_URL}/download` } };
}

const OSES: Os[] = ["windows", "macos", "linux"];

/**
 * Windows visitors get FORGE-Setup.exe straight away, like the old download button; `?os=` shows the page
 * for a chosen system instead (the tabs link there).
 */
export default async function Download({ searchParams }: { searchParams: Promise<{ os?: string }> }) {
  const [{ os: asked }, head, { locale }] = await Promise.all([searchParams, headers(), getRoute()]);
  const chosen = OSES.find((o) => o === asked);
  const detected = detectOs(head.get("sec-ch-ua-platform"), head.get("user-agent"));
  if (!chosen && detected === "windows") redirect(DOWNLOAD_URL);
  let builds: Builds | null;
  try {
    builds = await latestBuilds();
  } catch (err) {
    console.error("builds failed:", err instanceof Error ? err.message : err);
    builds = null;
  }
  return <DownloadPage locale={locale} os={chosen ?? detected ?? "macos"} phone={!chosen && detected === null} builds={builds} />;
}
