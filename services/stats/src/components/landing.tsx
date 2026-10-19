import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, BookOpen, Bot, Coins, Download, Gauge, GitBranch, GitFork, MessagesSquare, Minus, MonitorDown, MonitorPlay, Phone, ShieldCheck, Square, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import shotDe from "@/assets/app-de.webp";
import shotEn from "@/assets/app-en.webp";
import mark from "@/assets/logo-mark.svg";
import { DOWNLOAD_URL, REPO_URL } from "@/lib/constants";
import { getTotals } from "@/lib/db";
import { tokenSum } from "@/lib/history";
import type { Locale } from "@/lib/i18n";
import { i18n, type Messages } from "@/lib/messages";
import { Skeleton } from "./blocks";
import { CountUp, Reveal } from "./motion";

const SHOTS = { de: shotDe, en: shotEn } as const;

type FeatureKey = keyof Messages["landing"]["features"];

const FEATURES: { key: FeatureKey; icon: LucideIcon }[] = [
  { key: "sessions", icon: MessagesSquare },
  { key: "agents", icon: Bot },
  { key: "git", icon: GitBranch },
  { key: "preview", icon: MonitorPlay },
  { key: "safe", icon: ShieldCheck },
  { key: "knowledge", icon: BookOpen },
  { key: "usage", icon: Gauge },
  { key: "phone", icon: Phone },
];

/** The start page: what FORGE is, a look at the app, what it does, a few numbers and the download. */
export function Landing({ locale, numbers }: { locale: Locale; numbers: ReactNode }) {
  const { t } = i18n(locale);
  const l = t.landing;
  const shot = SHOTS[locale];
  return (
    <main className="landing">
      <section className="hero">
        <div className="container hero-inner">
          <div className="hero-text">
            <span className="hero-badge">
              <span className="hero-badge-dot" aria-hidden />
              {l.badge}
            </span>
            <h1 className="hero-title">
              <span className="hero-name">{l.title}</span>
              <span className="hero-subtitle">{l.subtitle}</span>
            </h1>
            <p className="hero-lead">{l.lead}</p>
            <DownloadButtons locale={locale} />
            <ul className="hero-facts">
              {l.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div className="hero-shot">
            <div className="window">
              <div className="window-bar" aria-hidden>
                <img src={mark.src} width={18} height={14} alt="" className="window-mark" />
                <span className="window-title">FORGE</span>
                <span className="window-controls">
                  <Minus />
                  <Square />
                  <X />
                </span>
              </div>
              <img src={shot.src} width={shot.width} height={shot.height} alt={l.screenshotAlt} className="window-img" fetchPriority="high" />
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="container landing-section" aria-labelledby="features-title">
        <Reveal>
          <header className="landing-head">
            <h2 id="features-title">{l.featuresTitle}</h2>
            <p>{l.featuresText}</p>
          </header>
          <div className="features">
            {FEATURES.map(({ key, icon: Icon }, i) => (
              <article key={key} className="feature" style={{ "--i": i } as CSSProperties}>
                <span className="feature-icon">
                  <Icon aria-hidden />
                </span>
                <h3>{l.features[key].title}</h3>
                <p>{l.features[key].text}</p>
              </article>
            ))}
          </div>
        </Reveal>
      </section>

      <section className="container landing-section" aria-labelledby="numbers-title">
        {numbers}
      </section>

      <section className="container landing-section">
        <Reveal>
          <div className="cta">
            <h2>{l.cta.title}</h2>
            <p>{l.cta.text}</p>
            <DownloadButtons locale={locale} />
          </div>
        </Reveal>
      </section>
    </main>
  );
}

function DownloadButtons({ locale }: { locale: Locale }) {
  const l = i18n(locale).t.landing;
  return (
    <div className="hero-actions">
      <a className="btn btn-primary btn-lg" href={DOWNLOAD_URL}>
        <Download aria-hidden />
        {l.download}
        <ArrowRight aria-hidden className="btn-arrow" />
      </a>
      <a className="btn btn-outline btn-lg" href={REPO_URL}>
        <GitFork aria-hidden />
        {l.github}
      </a>
    </div>
  );
}

function numberCards(locale: Locale) {
  const n = i18n(locale).t.landing.numbers;
  return [
    { key: "tokens", icon: Coins, label: n.tokens },
    { key: "sessions", icon: MessagesSquare, label: n.sessions },
    { key: "agents", icon: Bot, label: n.agents },
    { key: "installs", icon: MonitorDown, label: n.installs },
  ] as const;
}

function NumbersFrame({ locale, children }: { locale: Locale; children: ReactNode }) {
  const n = i18n(locale).t.landing.numbers;
  return (
    <div className="numbers">
      <header className="numbers-head">
        <div>
          <h2 id="numbers-title">{n.title}</h2>
          <p>{n.text}</p>
        </div>
        <a className="numbers-link" href="/stats">
          {n.all}
          <ArrowRight aria-hidden />
        </a>
      </header>
      <div className="numbers-grid">{children}</div>
    </div>
  );
}

/** Four totals from the statistics; without the database the section is left out. */
export async function Numbers({ locale }: { locale: Locale }) {
  let values: Record<"tokens" | "sessions" | "agents" | "installs", number>;
  try {
    const totals = await getTotals();
    const c = totals.counters;
    values = { tokens: tokenSum(c), sessions: c.sessions, agents: c.agentsStarted, installs: totals.installs };
  } catch (err) {
    console.error("totals failed:", err instanceof Error ? err.message : err);
    return null;
  }
  return (
    <Reveal>
      <NumbersFrame locale={locale}>
        {numberCards(locale).map(({ key, icon: Icon, label }) => (
          <div key={key} className="number">
            <Icon className="number-icon" aria-hidden />
            <span className="number-value">
              <CountUp value={values[key]} />
            </span>
            <span className="number-label">{label}</span>
          </div>
        ))}
      </NumbersFrame>
    </Reveal>
  );
}

export function NumbersSkeleton({ locale }: { locale: Locale }) {
  return (
    <div aria-busy>
      <NumbersFrame locale={locale}>
        {numberCards(locale).map(({ key, icon: Icon, label }, i) => (
          <div key={key} className="number">
            <Icon className="number-icon" aria-hidden />
            <span className="number-value">
              <Skeleton width={`${40 + ((i * 19) % 30)}%`} />
            </span>
            <span className="number-label">{label}</span>
          </div>
        ))}
      </NumbersFrame>
    </div>
  );
}
