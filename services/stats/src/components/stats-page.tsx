import { EyeOff, Fingerprint, ToggleLeft, Trash2, TriangleAlert } from "lucide-react";
import type { Totals } from "@/lib/db";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/messages";
import { Eyebrow, Feature, Skeleton, SparkSkeleton, Stat } from "./blocks";
import { ChartsSkeleton } from "./charts";
import { LiveStats } from "./live-stats";
import { tileShapes } from "./tiles";

export type PageState = { kind: "loading" } | { kind: "error" } | { kind: "ok"; totals: Totals };

const PRIVACY = [
  { key: "off", icon: ToggleLeft },
  { key: "anonymous", icon: Fingerprint },
  { key: "notCollected", icon: EyeOff },
  { key: "delete", icon: Trash2 },
] as const;

/** Live stats after the owner's mockup: head on the left, four cards, two charts, top models and platforms. */
export function StatsPage({ state, locale }: { state: PageState; locale: Locale }) {
  const { t } = i18n(locale);
  const s = t.stats;
  return (
    <main className="stats">
      <section className="container stats-body" aria-busy={state.kind === "loading" || undefined}>
        <header className="stats-head">
          <Eyebrow>{s.eyebrow}</Eyebrow>
          <h1>
            {s.title} <span className="stats-title-accent">{s.titleAccent}</span>
          </h1>
          <p>{s.lead}</p>
        </header>

        {state.kind === "error" ? (
          <div className="error-banner" role="alert">
            <TriangleAlert aria-hidden />
            <div>
              <div className="error-title">{t.unavailable.title}</div>
              <div>{t.unavailable.text}</div>
            </div>
          </div>
        ) : state.kind === "ok" ? (
          <LiveStats initial={state.totals} />
        ) : (
          <>
            <div className="stats-meta">
              <Skeleton width="4.5rem" style={{ height: 30, borderRadius: 999 }} />
              <Skeleton width="16rem" />
            </div>
            <div className="stats-grid">
              {tileShapes(locale).map((tile, i) => (
                <Stat
                  key={tile.label}
                  icon={tile.icon}
                  label={tile.label}
                  index={i}
                  value={<Skeleton width={`${45 + ((i * 23) % 30)}%`} />}
                  sub={tile.sub}
                  spark={<SparkSkeleton />}
                />
              ))}
            </div>
            <ChartsSkeleton />
          </>
        )}
      </section>

      <section className="container stats-privacy" aria-labelledby="privacy-title">
        <header className="section-head">
          <h2 id="privacy-title">{s.privacy.title}</h2>
          <p>{s.privacy.text}</p>
        </header>
        <div className="features">
          {PRIVACY.map(({ key, icon }, i) => (
            <Feature key={key} icon={icon} title={s.privacy.items[key].title} text={s.privacy.items[key].text} index={i} />
          ))}
        </div>
        <p className="footnote">{s.footnote}</p>
      </section>
    </main>
  );
}
