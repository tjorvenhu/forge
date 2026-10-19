import type { MetadataRoute } from "next";
import { LOCALES, localePath } from "@/lib/i18n";
import { SITE_URL, type PagePath } from "@/lib/seo";

const PAGES: { path: PagePath; changeFrequency: "daily" | "weekly"; priority: number }[] = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  // The numbers change all the time.
  { path: "/stats", changeFrequency: "daily", priority: 0.7 },
];

/** Every page in both languages, each with its alternates (hreflang) and the unprefixed x-default. */
export default function sitemap(): MetadataRoute.Sitemap {
  const url = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;
  return PAGES.flatMap(({ path, changeFrequency, priority }) => {
    const languages = { ...Object.fromEntries(LOCALES.map((l) => [l, url(localePath(path, `/${l}`))])), "x-default": url(path) };
    return [path, ...LOCALES.map((l) => localePath(path, `/${l}`))].map((p) => ({
      url: url(p),
      lastModified: new Date(),
      changeFrequency,
      priority: p === path ? priority : priority * 0.9,
      alternates: { languages },
    }));
  });
}
