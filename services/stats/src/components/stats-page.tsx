import { Activity, Cpu, EyeOff, Power, Send, TriangleAlert } from "lucide-react";
import type { Totals } from "@/lib/db";
import { Group, Row, SectionTitle, Skeleton } from "./blocks";
import { ChartsSkeleton } from "./charts";
import { LiveStats } from "./live-stats";
import { TILE_SHAPES, TOKEN_ROWS } from "./tiles";

export type PageState = { kind: "loading" } | { kind: "error" } | { kind: "ok"; totals: Totals };

export function StatsPage({ state }: { state: PageState }) {
  return (
    <main className="container content">
      <div className="intro">
        <h1>FORGE in Zahlen</h1>
        <p>FORGE ist eine Desktop-Oberfläche für Claude Code. Hier stehen die Summen aller Installationen, die anonyme Nutzungszahlen senden. Gezählt wird ab dem 17. Oktober 2026, dem Start der Statistik.</p>
      </div>

      {state.kind === "error" ? (
        <div className="error-banner" role="alert">
          <TriangleAlert aria-hidden />
          <div>
            <div className="error-title">Die Zahlen sind gerade nicht abrufbar</div>
            <div>Die Datenbank antwortet nicht. Bitte versuche es in ein paar Minuten noch einmal.</div>
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
              <span id="figures">Kennzahlen</span>
            </SectionTitle>
            <div className="tiles">
              {TILE_SHAPES.map((t, i) => (
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

          <Group title="Tokens im Detail" description="Alle Claude-Anfragen aus FORGE, nach Art der Tokens">
            {TOKEN_ROWS.map((r, i) => (
              <Row key={r.key} icon={r.icon} label={r.label} description={r.description}>
                <Skeleton width={`${4 + ((i * 3) % 3)}rem`} />
              </Row>
            ))}
          </Group>
        </>
      )}

      <Group title="Was erfasst wird" description="Abschaltbar in FORGE unter Einstellungen > Über FORGE > Datenschutz">
        <Row
          icon={Send}
          label="Gemeldet"
          description="Alle 5 Minuten die Gesamtzähler seit dem 17. Oktober 2026: Tokens, Arbeitszeit, Durchläufe, Sessions, Projekte, Agenten und Telefonate. Dazu eine zufällige Installations-ID, die FORGE-Version, das Betriebssystem und die Art des Claude-Abos (zum Beispiel Pro oder Max 5x)."
        />
        <Row
          icon={Cpu}
          label="Modelle und Kosten"
          description="Neuere FORGE-Versionen melden zusätzlich die Tokens je Claude-Modell und die geschätzten Kosten nach API-Preisen in US-Dollar. Das ist ein Rechenwert, kein Betrag, den jemand bezahlt hat."
        />
        <Row icon={Activity} label="Verlauf" description="Der Dienst speichert pro Installation den letzten Stand jedes Tages. Daraus entstehen die Zahlen pro Tag." />
        <Row icon={EyeOff} label="Nicht erfasst" description="Inhalte von Nachrichten, Dateien, Projektnamen und IP-Adressen." />
        <Row icon={Power} label="Abschalten" description="Wer die Statistik abschaltet, löscht damit auch den gespeicherten Datensatz seiner Installation." />
      </Group>

      <p className="footnote">Die Summen werden alle 5 Minuten neu berechnet. Tage beginnen um 0 Uhr UTC.</p>
    </main>
  );
}
