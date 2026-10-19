---
title: "SEO der Website forge.vanturis.de (Sprach-URLs /de /en, proxy.ts, hreflang, OG-Bilder, JSON-LD, Sitemap)"
summary: "Wie die Website in services/stats für Suchmaschinen aufgebaut ist: Sprach-URLs über proxy.ts, Canonical und hreflang, OG-Bilder per Skript, strukturierte Daten, FAQ unter dem ersten Bildschirm, robots und Sitemap; nötig vor neuen Seiten, Texten oder Bildern der Website."
tags: ["stats","seo","i18n","konvention","stolperfalle"]
updated: "2026-10-19T20:22:42.430Z"
---

# SEO der Website (services/stats), eingebaut 2026-10-19

## Sprach-URLs
- Problem vorher: `/` und `/stats` wählen die Sprache nach Cookie `lang` bzw. Accept-Language. Google crawlt ohne beides und hätte nur Englisch gesehen.
- Jetzt: `/de`, `/en`, `/de/stats`, `/en/stats` mit fester Sprache. `src/proxy.ts` (Next 16 heißt Middleware jetzt `proxy`, Funktion `proxy`) schreibt sie auf `/` bzw. `/stats` um und setzt den Request-Header `x-forge-locale` (`LOCALE_HEADER` in `lib/i18n.ts`); bei Pfaden ohne Präfix löscht er einen mitgeschickten Header.
- `/` und `/stats` bleiben automatisch (Links aus der App wie `STATS_PAGE_URL` funktionieren weiter) und sind `x-default`.
- Server: `getRoute()` in `lib/locale-server.ts` liefert `{ locale, base }` (`base` = "" | "/de" | "/en"). Client: `useLocaleBase()` aus `components/locale.tsx`. Interne Links immer mit `localePath(path, base)`, sonst springt man von `/de` auf die automatische Seite.
- Sprachumschalter: auf Präfix-Seiten schickt das Formular ein verstecktes Feld `page`, `setLocale` setzt das Cookie und leitet auf die andere Sprache um (`/de/stats` → `/en/stats`). Ohne Präfix wie bisher nur Cookie und neu rendern.
- Neue Seite: in den Matcher von `proxy.ts`, die Regex dort, `PagePath` in `lib/seo.ts`, `PAGES` in `app/sitemap.ts`.

## Metadaten (`lib/seo.ts`)
- `siteMetadata(locale)` im Layout: `metadataBase`, Keywords, Herausgeber Vanturis UG, robots mit `max-image-preview: large`.
- `pageMetadata(path, locale, base)` je Seite: Titel und Beschreibung aus `messages.ts` (`meta`, `statsMeta`), Canonical = eigene URL, `alternates.languages` en/de/x-default, Open Graph und Twitter-Karte mit Bild.
- JSON-LD als `<script type="application/ld+json">` in `page.tsx` bzw. `stats/page.tsx`: Start = Organization, WebSite, SoftwareApplication (kostenlos, Windows 10/11, AGPL, Download-URL), FAQPage aus `landing.faq.items`; Stats = WebPage + BreadcrumbList. `jsonLdScript` maskiert `<`. Keine Bewertungen oder Downloadzahlen erfinden.

## Inhalte
- FAQ-Abschnitt unter dem ersten Bildschirm der Landingpage (`landing.faq` in `messages.ts`, `<details>`, Stile `.landing-faq`/`.faq-item` in `pages.css`). Der erste Bildschirm (Vorlage des Besitzers) blieb unverändert. Antworten nur mit belegten Fakten aus README.de.md; Textregeln des Besitzers: keine Gedankenstriche, keine Metaphern.
- **Stolperfalle (behoben 2026-10-19):** Die FAQ lag zuerst im selben Flex-Container `.landing` (min-height `calc(100svh - 77px)`) wie Hero, Karten und Stats-Link. Dadurch teilten sie sich die Fensterhöhe, der Hero schrumpfte und die Fragen waren schon im ersten Bildschirm zu sehen. Der Besitzer will den ersten Bildschirm wieder vollflächig, die Fragen und danach den Footer erst beim Scrollen. Jetzt liegen Hero, Karten und Stats-Link in `.landing-first` (trägt die volle Höhe, unter 1080 px `min-height: 0`), `.landing` hat nur noch `overflow-x: clip`. Neue Abschnitte unter dem ersten Bildschirm gehören außerhalb von `.landing-first`.

## OG-Bilder
`node scripts/og-images.mjs` in services/stats erzeugt `src/assets/og-{de,en}.png` (1200x630): weichgezeichneter Seitenhintergrund, Wortmarke, Titel und Lead, App-Screenshot rechts. sharp kommt über `next` (keine eigene Abhängigkeit), Schrift sind die Systemschriften (Segoe UI unter Windows). Nach neuen Screenshots oder Texten neu erzeugen. sharp nimmt nur Overlays, die ins Bild passen: das Skript schneidet sie mit `fit()` zu.

## Weitere Dateien
`app/robots.ts` (alles erlaubt außer `/api/`, Sitemap-Verweis), `app/sitemap.ts` (alle Sprachvarianten mit hreflang), `app/manifest.ts`.

## Lokal ansehen
services/stats liegt außerhalb des pnpm-Workspace: Abhängigkeiten mit `pnpm install --ignore-workspace --frozen-lockfile` im Ordner (ohne den Schalter installiert pnpm nur den Root-Workspace und `next` fehlt). Die Startseite braucht keine Datenbank. Ist Port 4100 von einer anderen Session belegt, einen anderen Port nehmen statt den Prozess zu beenden.

## Nach dem Deploy (Besitzer)
In Coolify neu ausrollen; Sitemap `https://forge.vanturis.de/sitemap.xml` in der Google Search Console und bei Bing einreichen. Prüfen: Rich-Results-Test für die Startseite.
