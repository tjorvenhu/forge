import type { Metadata } from "next";
import ogDe from "@/assets/og-de.png";
import ogEn from "@/assets/og-en.png";
import shotDe from "@/assets/app-de-1600.webp";
import shotEn from "@/assets/app-en-1600.webp";
import { DOWNLOAD_URL, REPO_URL } from "./constants";
import { LOCALES, localePath, type Locale, type LocaleBase } from "./i18n";
import { i18n } from "./messages";

export const SITE_URL = "https://forge.vanturis.de";
export const SITE_NAME = "FORGE";
const PUBLISHER = { name: "Vanturis UG (haftungsbeschränkt)", url: "https://vanturis.de" } as const;

export type PagePath = "/" | "/stats";

/** Link previews (scripts/og-images.mjs), 1200 x 630. */
const OG_IMAGES = { de: ogDe, en: ogEn } as const;
const SCREENSHOTS = { de: shotDe, en: shotEn } as const;
const OG_LOCALE = { de: "de_DE", en: "en_US" } as const;

const absolute = (path: string) => new URL(path, SITE_URL).toString();

/**
 * Title, description, canonical URL, the other languages (hreflang) and the link preview of a page.
 * /de and /en pages are canonical for their language; the unprefixed page follows the visitor's
 * language and is the x-default.
 */
export function pageMetadata(path: PagePath, locale: Locale, base: LocaleBase): Metadata {
  const { t } = i18n(locale);
  const m = path === "/stats" ? t.statsMeta : t.meta;
  const url = localePath(path, base);
  const og = OG_IMAGES[locale];
  return {
    title: m.title,
    description: m.description,
    alternates: {
      canonical: url,
      languages: { ...Object.fromEntries(LOCALES.map((l) => [l, localePath(path, `/${l}`)])), "x-default": path },
    },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: m.title,
      description: m.description,
      url,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      images: [{ url: og.src, width: og.width, height: og.height, alt: t.meta.ogAlt, type: "image/png" }],
    },
    twitter: {
      card: "summary_large_image",
      title: m.title,
      description: m.description,
      images: [{ url: og.src, alt: t.meta.ogAlt }],
    },
  };
}

/** What every page shares: base URL, robots, author and keywords. */
export function siteMetadata(locale: Locale): Metadata {
  const { t } = i18n(locale);
  return {
    metadataBase: new URL(SITE_URL),
    applicationName: SITE_NAME,
    title: t.meta.title,
    description: t.meta.description,
    keywords: t.meta.keywords,
    authors: [PUBLISHER],
    creator: PUBLISHER.name,
    publisher: PUBLISHER.name,
    category: "technology",
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

type JsonLd = Record<string, unknown>;

const organization: JsonLd = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: PUBLISHER.name,
  url: PUBLISHER.url,
  logo: absolute("/icon.svg"),
};

/** Structured data of the start page: the site, its publisher, the app itself and the questions on the page. */
export function homeJsonLd(locale: Locale, base: LocaleBase): JsonLd {
  const { t } = i18n(locale);
  const url = absolute(localePath("/", base));
  return {
    "@context": "https://schema.org",
    "@graph": [
      organization,
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        description: t.meta.description,
        inLanguage: LOCALES,
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        description: t.meta.appDescription,
        url,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "AI coding assistant",
        operatingSystem: "Windows 10, Windows 11",
        downloadUrl: DOWNLOAD_URL,
        installUrl: DOWNLOAD_URL,
        screenshot: absolute(SCREENSHOTS[locale].src),
        image: absolute(OG_IMAGES[locale].src),
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        isAccessibleForFree: true,
        inLanguage: LOCALES,
        offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
        publisher: { "@id": `${SITE_URL}/#organization` },
        sameAs: [REPO_URL],
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        inLanguage: locale,
        mainEntity: t.landing.faq.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  };
}

/** Structured data of the live stats: a page of the site with the way back to the start page. */
export function statsJsonLd(locale: Locale, base: LocaleBase): JsonLd {
  const { t } = i18n(locale);
  const url = absolute(localePath("/stats", base));
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": url,
        url,
        name: t.statsMeta.title,
        description: t.statsMeta.description,
        inLanguage: locale,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        breadcrumb: { "@id": `${url}#breadcrumb` },
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: absolute(localePath("/", base)) },
          { "@type": "ListItem", position: 2, name: t.header.liveStats, item: url },
        ],
      },
    ],
  };
}

/** JSON for a script tag: "<" escaped so no text in it can close the tag. */
export function jsonLdScript(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
