import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GitFork, Heart } from "lucide-react";
import logo from "@/assets/forge-logo.png";
import "./globals.css";

const REPO_URL = "https://github.com/vanturis/forge";
const DONATE_URL = "https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600";
const IMPRINT_URL = "https://vanturis.de/impressum";
const PRIVACY_URL = "https://vanturis.de/datenschutz";

export const metadata: Metadata = {
  title: "FORGE in Zahlen",
  description: "Gesamtzahlen aller FORGE-Installationen, die anonyme Nutzungszahlen senden.",
};

// The app has only its dark theme; the page follows it.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#14171d",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" className={GeistSans.variable}>
      <body>
        <header className="topbar">
          <div className="container topbar-inner">
            {/* Shown at 28px, the source is 1055 x 223 and stays sharp. */}
            <img src={logo.src} width={132} height={28} alt="FORGE, Claude Development Studio" className="logo" />
            <nav className="topbar-actions" aria-label="Links">
              <a className="btn btn-outline" href={REPO_URL} aria-label="FORGE auf GitHub">
                <GitFork aria-hidden />
                <span className="btn-label-wide">GitHub</span>
              </a>
              <a className="btn btn-primary" href={DONATE_URL}>
                <Heart aria-hidden />
                Unterstützen
              </a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="footer">
          <div className="container footer-inner">
            <span>FORGE ist ein Open-Source-Produkt der Vanturis UG (haftungsbeschränkt), lizenziert unter AGPL-3.0.</span>
            <span className="footer-links">
              <a href={IMPRINT_URL}>Impressum</a>
              <a href={PRIVACY_URL}>Datenschutz</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
