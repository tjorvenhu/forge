import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GitFork } from "lucide-react";
import logo from "@/assets/forge-logo.png";
import { donations, type Donations } from "@/lib/donations";
import { SupportButton } from "@/components/donations";
import { LanguageSwitch, LocaleProvider } from "@/components/locale";
import { getLocale } from "@/lib/locale-server";
import { i18n } from "@/lib/messages";
import "./globals.css";

const REPO_URL = "https://github.com/vanturis/forge";
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
            <style>{".reveal{opacity:1;transform:none}.reveal .col-bar,.reveal .hbar-fill{animation:none}"}</style>
          </noscript>
          <header className="topbar">
            <div className="container topbar-inner">
              {/* Shown at 28px, the source is 1055 x 223 and stays sharp. */}
              <img src={logo.src} width={132} height={28} alt={t.header.logoAlt} className="logo" />
              <nav className="topbar-actions" aria-label={t.header.links}>
                <LanguageSwitch />
                <a className="btn btn-outline" href={REPO_URL} aria-label={t.header.github}>
                  <GitFork aria-hidden />
                  <span className="btn-label-wide">GitHub</span>
                </a>
                <SupportButton donations={given} />
              </nav>
            </div>
          </header>
          {children}
          <footer className="footer">
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
