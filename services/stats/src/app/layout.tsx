import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GitFork, Heart } from "lucide-react";
import logo from "@/assets/forge-logo.png";
import "./globals.css";

const REPO_URL = "https://github.com/tjorvenhu/forge";
const DONATE_URL = "https://paypal.me/tjorvenhu";
const IMPRINT_URL = "https://vanturis.de/impressum";

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
            <span>Betrieben von Vanturis</span>
            <a href={IMPRINT_URL}>Impressum</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
