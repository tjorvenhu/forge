import { ArrowRight, BarChart3, ChevronDown, Download, Folder, GitBranch, MessageCircle, Monitor, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import de800 from "@/assets/app-de-800.webp";
import de1200 from "@/assets/app-de-1200.webp";
import de1600 from "@/assets/app-de-1600.webp";
import de2400 from "@/assets/app-de-2400.webp";
import en800 from "@/assets/app-en-800.webp";
import en1200 from "@/assets/app-en-1200.webp";
import en1600 from "@/assets/app-en-1600.webp";
import en2400 from "@/assets/app-en-2400.webp";
import { DOWNLOAD_PAGE } from "@/lib/constants";
import { localePath, type Locale, type LocaleBase } from "@/lib/i18n";
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

/** The start page: one full screen with the app window, four cards and the way to the live stats; the questions below it. */
export function Landing({ locale, base }: { locale: Locale; base: LocaleBase }) {
  const { t } = i18n(locale);
  const l = t.landing;
  const stats = localePath("/stats", base);
  const shots = SHOTS[locale];
  const shot = shots[shots.length - 1]!;
  return (
    <main className="landing">
      {/* The first screen fills the window; the questions and the footer come only when scrolling. */}
      <div className="landing-first">
      <section className="hero">
        <div className="container hero-inner">
          <div className="hero-text">
            <h1 className="hero-title">
              <span>{l.title}</span>
              <span className="hero-title-accent">{l.titleAccent}</span>
            </h1>
            <p className="hero-lead">{l.lead}</p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href={DOWNLOAD_PAGE}>
                <Download aria-hidden />
                {l.download}
              </a>
              <a className="btn btn-outline btn-lg" href={stats}>
                <BarChart3 aria-hidden />
                {l.liveStats}
              </a>
            </div>
            <ul className="hero-facts">
              <li>
                <Monitor size={15} aria-hidden />
                {l.facts.platforms}
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
        <a className="stats-link" href={stats}>
          <BarChart3 aria-hidden />
          {l.liveStats}
          <ArrowRight aria-hidden className="btn-arrow" />
        </a>
      </div>
      </div>

      <section className="container landing-faq" id="faq" aria-labelledby="faq-title">
        <header className="section-head">
          <h2 id="faq-title">{l.faq.title}</h2>
          <p>{l.faq.lead}</p>
        </header>
        <div className="faq">
          {l.faq.items.map((item) => (
            <details key={item.q} className="faq-item">
              <summary>
                <h3>{item.q}</h3>
                <ChevronDown aria-hidden className="faq-chevron" />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
