import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { Download } from "lucide-react";
import logo from "@/assets/forge-logo.png";
import { donations, type Donations } from "@/lib/donations";
import { SupportButton } from "@/components/donations";
import { PageLinks } from "@/components/nav";
import { DOWNLOAD_URL } from "@/lib/constants";
import { LanguageSwitch, LocaleProvider } from "@/components/locale";
import { getLocale } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";
import "./globals.css";
import "./landing.css";

const IMPRINT_URL = "https://vanturis.de/impressum";
const PRIVACY_URL = "https://vanturis.de/datenschutz";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = i18n(await getLocale());
  return { title: t.meta.title, description: t.meta.description };
}

// The app has only its dark theme; the page follows it.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#14171d",
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [given, locale] = await Promise.all([donated(), getLocale()]);
  const { t } = i18n(locale);
  return (
    <html lang={locale} className={GeistSans.variable}>
      <body>
        <LocaleProvider locale={locale}>
          {/* Without JavaScript nothing scrolls into view: show charts and bars as they are. */}
          <noscript>
            <style>{".reveal,.reveal .feature{opacity:1;transform:none}.reveal .col-bar,.reveal .hbar-fill{animation:none}"}</style>
          </noscript>
          <header className="topbar">
            <div className="container topbar-inner">
              <a href="/" className="logo-link" aria-label={t.header.home}>
                {/* Shown at 28px, the source is 945 x 223 and stays sharp. */}
                <img src={logo.src} width={119} height={28} alt="" className="logo" />
              </a>
              <nav className="topbar-nav" aria-label={t.header.nav}>
                <PageLinks className="nav-links" />
              </nav>
              <div className="topbar-actions" role="group" aria-label={t.header.links}>
                <LanguageSwitch />
                <SupportButton donations={given} />
                <a className="btn btn-primary" href={DOWNLOAD_URL} aria-label={t.header.download}>
                  <Download aria-hidden />
                  <span className="btn-label-wide">{t.header.download}</span>
                </a>
              </div>
            </div>
          </header>
          {children}
          <footer className="footer">
            <div className="container">
              <div className="footer-top">
                <a href="/" className="logo-link" aria-label={t.header.home}>
                  <img src={logo.src} width={102} height={24} alt="" className="logo" />
                </a>
                <nav aria-label={t.header.nav}>
                  <PageLinks className="footer-nav" />
                </nav>
                <span className="footer-tagline">
                  <span className="footer-dot" aria-hidden />
                  {t.footer.tagline}
                </span>
              </div>
            </div>
            <div className="container footer-inner">
              <span>{t.footer.license}</span>
              <span className="footer-links">
                <a href={IMPRINT_URL}>{t.footer.imprint}</a>
                <a href={PRIVACY_URL}>{t.footer.privacy}</a>
              </span>
            </div>
          </footer>
        </LocaleProvider>
      </body>
    </html>
  );
}
