import type { MetadataRoute } from "next";
import { getLocale } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";
import { SITE_NAME } from "@/lib/seo";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { t } = i18n(await getLocale());
  return {
    name: t.meta.title,
    short_name: SITE_NAME,
    description: t.meta.description,
    start_url: "/",
    display: "browser",
    background_color: "#111418",
    theme_color: "#111418",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon.png", type: "image/png", sizes: "256x256" },
    ],
  };
}
