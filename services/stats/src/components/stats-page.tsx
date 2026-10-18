import { Activity, Cpu, EyeOff, Power, Send, ToggleLeft, TriangleAlert, UserCheck } from "lucide-react";
import type { Totals } from "@/lib/db";
import type { Locale } from "@/lib/i18n";
import { i18n } from "@/lib/messages";
import { Group, Row, SectionTitle, Skeleton } from "./blocks";
import { ChartsSkeleton } from "./charts";
import { LiveStats } from "./live-stats";
import { tileShapes, tokenRows } from "./tiles";

export type PageState = { kind: "loading" } | { kind: "error" } | { kind: "ok"; totals: Totals };

export function StatsPage({ state, locale }: { state: PageState; locale: Locale }) {
  const { t } = i18n(locale);
  const c = t.collected;
  return (
    <main className="container content">
      <div className="intro">
        <h1>{t.intro.title}</h1>
        <p>{t.intro.text}</p>
      </div>

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
          <section aria-labelledby="figures" aria-busy>
            <SectionTitle
              action={
                <span className="section-meta">
                  <Skeleton width="9rem" />
                </span>
              }
            >
              <span id="figures">{t.figures.title}</span>
            </SectionTitle>
            <div className="tiles">
              {tileShapes(locale).map((t, i) => (
                <div key={t.label} className={t.wide ? "tile tile-wide" : "tile"}>
                  <div className="tile-head">
                    <span className="tile-label">{t.label}</span>
                    <t.icon className="tile-icon" aria-hidden />
                  </div>
                  <div className="tile-value">
                    <Skeleton width={`${45 + ((i * 23) % 30)}%`} />
                  </div>
                  <div className="tile-sub">
                    <Skeleton width={`${50 + ((i * 17) % 35)}%`} />
                  </div>
                </div>
              ))}
            </div>
            <p className="tiles-note">
              <Skeleton width="70%" />
            </p>
          </section>

          <ChartsSkeleton />

          <Group title={t.tokens.title} description={t.tokens.description}>
            {tokenRows(locale).map((r, i) => (
              <Row key={r.key} icon={r.icon} label={r.label} description={r.description}>
                <Skeleton width={`${4 + ((i * 3) % 3)}rem`} />
              </Row>
            ))}
          </Group>
        </>
      )}

      <Group title={c.title} description={c.description}>
        <Row icon={ToggleLeft} label={c.offByDefault} description={c.offByDefaultText} />
        <Row icon={UserCheck} label={c.who} description={c.whoText} />
        <Row icon={Send} label={c.reported} description={c.reportedText} />
        <Row icon={Cpu} label={c.models} description={c.modelsText} />
        <Row icon={Activity} label={c.history} description={c.historyText} />
        <Row icon={EyeOff} label={c.notCollected} description={c.notCollectedText} />
        <Row icon={Power} label={c.turnOff} description={c.turnOffText} />
      </Group>

      <p className="footnote">{t.footnote}</p>
    </main>
  );
}
