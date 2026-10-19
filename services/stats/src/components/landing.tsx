import { ArrowRight, BarChart3, Download, Folder, GitBranch, MessageCircle, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import de800 from "@/assets/app-de-800.webp";
import de1200 from "@/assets/app-de-1200.webp";
import de1600 from "@/assets/app-de-1600.webp";
import de2400 from "@/assets/app-de-2400.webp";
import en800 from "@/assets/app-en-800.webp";
import en1200 from "@/assets/app-en-1200.webp";
import en1600 from "@/assets/app-en-1600.webp";
import en2400 from "@/assets/app-en-2400.webp";
import { DOWNLOAD_URL } from "@/lib/constants";
import type { Locale } from "@/lib/i18n";
import { i18n, type Messages } from "@/lib/messages";
import { Feature } from "./blocks";
import { Tilt } from "./tilt";

/**
 * The app screenshot (taken at 2400 x 1680) in four widths: the browser picks the one closest to the
 * window's size on screen. Scaled down on the GPU under the 3D turn, a far larger file looked pixelated.
 */
const SHOTS = { de: [de800, de1200, de1600, de2400], en: [en800, en1200, en1600, en2400] } as const;

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
  const shots = SHOTS[locale];
  const shot = shots[shots.length - 1]!;
  return (
    <main className="landing">
      <section className="hero">
        <div className="container hero-inner">
          <div className="hero-text">
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

          <Tilt className="hero-shot">
            <div className="window">
              <div className="window-bar" aria-hidden>
                <span className="window-lights">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <img
                src={shots[2].src}
                srcSet={shots.map((s) => `${s.src} ${s.width}w`).join(", ")}
                sizes="(max-width: 1080px) 100vw, 50vw"
                width={shot.width}
                height={shot.height}
                alt={l.screenshotAlt}
                className="window-img"
                fetchPriority="high"
              />
            </div>
          </Tilt>
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
