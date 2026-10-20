import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Download } from "lucide-react";
import logo from "@/assets/forge-wordmark.png";
import { donations, type Donations } from "@/lib/donations";
import { SupportButton } from "@/components/donations";
import { TopLinks } from "@/components/nav";
import { DOWNLOAD_PAGE, REPO_URL } from "@/lib/constants";
import { LanguageSwitch, LocaleProvider } from "@/components/locale";
import { localePath, type LocaleBase } from "@/lib/i18n";
import { getLocale, getRoute } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";
import { siteMetadata } from "@/lib/seo";
import "@fontsource-variable/inter";
import "./globals.css";
import "./pages.css";

const IMPRINT_URL = "https://vanturis.de/impressum";
const PRIVACY_URL = "https://vanturis.de/datenschutz";

export async function generateMetadata(): Promise<Metadata> {
  return siteMetadata(await getLocale());
}

// The app has only its dark theme; the page follows it.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#111418",
};

/** What the support dialog shows as given so far; left out without a Stripe key or when Stripe fails. */
async function donated(): Promise<Donations | null> {
  try {
    return await donations();
  } catch (err) {
    console.error("donations failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The wordmark (944 x 184): the mark and FORGE, without the line below it, as in the mockup. */
function Logo({ label, height, base }: { label: string; height: number; base: LocaleBase }) {
  return (
    <a href={localePath("/", base)} className="logo" aria-label={label}>
      <img src={logo.src} width={Math.round((height * 944) / 184)} height={height} alt="" />
    </a>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [given, { locale, base }] = await Promise.all([donated(), getRoute()]);
  const { t } = i18n(locale);
  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale} base={base}>
          {/* Without JavaScript nothing scrolls into view: show the charts as they are. */}
          <noscript>
            <style>{".reveal{opacity:1;transform:none}.reveal .col-bar,.reveal .hbar-fill{animation:none}"}</style>
          </noscript>
          <header className="topbar">
            <div className="container topbar-inner">
              <Logo label={t.header.home} height={34} base={base} />
              <nav className="topbar-nav" aria-label={t.header.nav}>
                <TopLinks />
                <SupportButton donations={given} />
                <a className="btn btn-primary" href={DOWNLOAD_PAGE} aria-label={t.header.download}>
                  <Download aria-hidden />
                  <span className="nav-label">{t.header.download}</span>
                </a>
              </nav>
            </div>
          </header>
          {children}
          <footer className="footer">
            <div className="container footer-inner">
              <div className="footer-brand">
                <Logo label={t.header.home} height={24} base={base} />
                <p>{t.footer.license}</p>
              </div>
              <div className="footer-side">
                <nav className="footer-links" aria-label={t.header.nav}>
                  <a href={localePath("/stats", base)}>{t.header.liveStats}</a>
                  <a href={REPO_URL}>{t.header.github}</a>
                  <a href={IMPRINT_URL}>{t.footer.imprint}</a>
                  <a href={PRIVACY_URL}>{t.footer.privacy}</a>
                </nav>
                <LanguageSwitch />
              </div>
            </div>
          </footer>
        </LocaleProvider>
      </body>
    </html>
  );
}
