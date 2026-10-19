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
        {/* a slanted panel with a lit edge behind the window */}
        <div className="hero-shape" aria-hidden />
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

/** The four panes of the Windows logo; lucide has no brand icons. */
function WindowsMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M0 2.3 6.6 1.4v6.2H0zM7.4 1.3 16 .1v7.5H7.4zM0 8.4h6.6v6.2L0 13.7zM7.4 8.4H16v7.5l-8.6-1.2z" />
    </svg>
  );
}
