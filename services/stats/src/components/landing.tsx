import { ArrowRight, BarChart3, Download, Folder, GitBranch, MessageCircle, Settings, Square, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import shotDe from "@/assets/app-de.webp";
import shotEn from "@/assets/app-en.webp";
import { DOWNLOAD_URL } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";
import { i18n, type Messages } from "@/lib/messages";
import { Eyebrow, Feature } from "./blocks";

const SHOTS = { de: shotDe, en: shotEn } as const;

type FeatureKey = keyof Messages["landing"]["features"];

const FEATURES: { key: FeatureKey; icon: LucideIcon }[] = [
  { key: "projects", icon: Folder },
  { key: "ui", icon: MessageCircle },
  { key: "git", icon: GitBranch },
  { key: "workflow", icon: Settings },
];

/** The start page: one screen with the app window, four cards below and the way to the live stats. */
export function Landing({ locale }: { locale: Locale }) {
  const { t } = i18n(locale);
  const l = t.landing;
  const shot = SHOTS[locale];
  return (
    <main className="landing">
      <section className="hero">
        <div className="container hero-inner">
          <div className="hero-text">
            <Eyebrow>{l.eyebrow}</Eyebrow>
            <h1 className="hero-title">
              <span>{l.title}</span>
              <span className="hero-title-accent">{l.titleAccent}</span>
            </h1>
            <p className="hero-lead">{l.lead}</p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={DOWNLOAD_URL}>
                <Download aria-hidden />
                {l.download}
              </a>
              <a className="btn btn-outline btn-lg" href="/stats">
                <BarChart3 aria-hidden />
                {l.liveStats}
              </a>
            </div>
            <ul className="hero-facts">
              <li>
                <WindowsMark />
                {l.facts.windows}
              </li>
              <li>{l.facts.openSource}</li>
              <li>{l.facts.earlyAccess}</li>
            </ul>
          </div>

          <div className="hero-shot">
            <HeroArt />
            <div className="window">
              <div className="window-bar" aria-hidden>
                <span className="window-lights">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="window-controls">
                  <Square />
                  <X />
                </span>
              </div>
              <img src={shot.src} width={shot.width} height={shot.height} alt={l.screenshotAlt} className="window-img" fetchPriority="high" />
            </div>
          </div>
        </div>
      </section>

      <section className="container landing-features" aria-label={l.eyebrow}>
        <div className="features">
          {FEATURES.map(({ key, icon }, i) => (
            <Feature key={key} icon={icon} title={l.features[key].title} text={l.features[key].text} index={i} />
          ))}
        </div>
      </section>

      <div className="container landing-foot">
        <a className="stats-link" href="/stats">
          <BarChart3 aria-hidden />
          {l.liveStats}
          <ArrowRight aria-hidden className="btn-arrow" />
        </a>
      </div>
    </main>
  );
}

/**
 * The shapes behind the window, drawn in the mockup's own pixels (1536 x 1024): a large dark plane whose far
 * edges catch the orange light, a lit curve and a floor edge left of the window. Stretched to .hero-art's box,
 * which pins the mockup's window position onto the real window.
 */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="380 60 1156 760" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="art-face" gradientUnits="userSpaceOnUse" x1="500" y1="130" x2="760" y2="470">
          <stop offset="0" className="art-stop-light" />
          <stop offset="0.4" className="art-stop-mid" />
          <stop offset="1" className="art-stop-clear" />
        </linearGradient>
        <radialGradient id="art-heat" gradientUnits="userSpaceOnUse" cx="1070" cy="190" r="360">
          <stop offset="0" className="art-stop-accent" stopOpacity="0.3" />
          <stop offset="0.4" className="art-stop-accent" stopOpacity="0.06" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="art-rim" gradientUnits="userSpaceOnUse" x1="742" y1="0" x2="1101" y2="0">
          <stop offset="0" className="art-stop-accent" stopOpacity="0.15" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="art-edge" gradientUnits="userSpaceOnUse" x1="0" y1="96" x2="0" y2="190">
          <stop offset="0" className="art-stop-accent" stopOpacity="0.9" />
          <stop offset="1" className="art-stop-accent" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="art-curve" gradientUnits="userSpaceOnUse" x1="622" y1="0" x2="742" y2="0">
          <stop offset="0" className="art-stop-accent" stopOpacity="0" />
          <stop offset="0.35" className="art-stop-accent" stopOpacity="0.55" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0.95" />
        </linearGradient>
        <radialGradient id="art-haze" gradientUnits="userSpaceOnUse" cx="745" cy="450" r="230">
          <stop offset="0" className="art-stop-accent" stopOpacity="0.1" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="art-floor" gradientUnits="userSpaceOnUse" x1="380" y1="0" x2="742" y2="0">
          <stop offset="0" className="art-stop-accent" stopOpacity="0" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="art-floor-edge" gradientUnits="userSpaceOnUse" x1="420" y1="0" x2="742" y2="0">
          <stop offset="0" className="art-stop-accent" stopOpacity="0" />
          <stop offset="1" className="art-stop-accent" stopOpacity="0.6" />
        </linearGradient>
        <filter id="art-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="art-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>

      <path
        className="art-plane"
        d="M482 140 L640 136 Q648 136 653 142 L660 149 Q665 153 672 153 L716 151 Q724 150 729 143 L742 123 L1101 96 L1051 176 L1040 420 L720 480 L657 322 Q630 240 601 228 Q575 220 545 213 Z"
        fill="url(#art-face)"
      />
      <path d="M742 123 L1101 96 L1051 176 L1040 420 L800 440 Z" fill="url(#art-heat)" />
      <path d="M482 140 L640 136 Q648 136 653 142 L660 149 Q665 153 672 153 L716 151 Q724 150 729 143 L742 123" className="art-highlight" />
      <path d="M1101 96 L1051 176" stroke="url(#art-edge)" strokeWidth="8" filter="url(#art-glow)" fill="none" />
      <path d="M742 123 L1101 96 L1051 176" stroke="url(#art-rim)" strokeWidth="1.4" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

      <path d="M600 330 L745 300 L745 540 L560 560 Z" fill="url(#art-haze)" />
      <path d="M626 527 C634 510 680 486 745 463" stroke="url(#art-curve)" strokeWidth="5" fill="none" filter="url(#art-soft)" />
      <path d="M626 527 C634 510 680 486 745 463" stroke="url(#art-curve)" strokeWidth="1.6" fill="none" strokeLinecap="round" vectorEffect="non-scaling-stroke" />

      <path d="M380 704 L745 652 L745 716 L380 748 Z" fill="url(#art-floor)" filter="url(#art-soft)" />
      <path d="M420 698 L745 652" stroke="url(#art-floor-edge)" strokeWidth="1.2" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The four panes of the Windows logo; lucide has no brand icons. */
function WindowsMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M0 2.3 6.6 1.4v6.2H0zM7.4 1.3 16 .1v7.5H7.4zM0 8.4h6.6v6.2L0 13.7zM7.4 8.4H16v7.5l-8.6-1.2z" />
    </svg>
  );
}
