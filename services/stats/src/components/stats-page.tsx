import { Activity, ArrowDownToLine, ArrowUpFromLine, BadgeDollarSign, Bot, Clock, Coins, Cpu, Database, DatabaseZap, EyeOff, FolderPlus, MessagesSquare, MonitorDown, Phone, Power, Repeat, Send, TriangleAlert, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ONLINE_MINUTES, type Totals } from "@/lib/db";
import { COUNTER_KEYS, type Counters } from "@/lib/report";
import { formatCount, formatDateTime, formatHours, formatUsd } from "@/lib/format";
import { tokenSum } from "@/lib/history";
import { Group, Row, SectionTitle, Skeleton, Tile } from "./blocks";
import { ChartsSkeleton, StatsCharts } from "./charts";

type TileDef = { icon: LucideIcon; label: string; value: string; unit?: string; sub: string; highlight?: boolean; wide?: boolean };

function tiles(t: Totals): TileDef[] {
  const c = t.counters;
  const pricedTokens = Object.values(t.models).reduce((n, m) => n + m.tokens, 0);
  return [
    // Every token Claude processed through FORGE, whatever started it (sessions, agents, helper calls, phone), cache included.
    {
      icon: Coins,
      label: "Tokens gesamt",
      value: formatCount(tokenSum(c)),
      sub: "alle Tokens über FORGE",
      highlight: true,
      wide: true,
    },
    // Only calls the app recorded with their model and cost (newer app versions) are in it, see the note below the tiles.
    {
      icon: BadgeDollarSign,
      label: "Wert in API-Preisen",
      value: `≈ ${formatUsd(c.costUsdCents)}`,
      sub: pricedTokens < tokenSum(c) ? `nur für ${formatCount(pricedTokens)} der ${formatCount(tokenSum(c))} Tokens bekannt` : "geschätzt nach API-Preisen",
      wide: true,
    },
    { icon: Clock, label: "Claude-Arbeitszeit", value: formatHours(c.claudeWorkMs), unit: "Std.", sub: "Laufzeit aller Durchläufe" },
    {
      icon: Repeat,
      label: "Durchläufe",
      value: formatCount(c.claudeTurns),
      sub: c.userTurns ? `${formatCount(c.userTurns)} von Nutzern gestartet` : "Aufträge an Claude",
    },
    { icon: MessagesSquare, label: "Sessions", value: formatCount(c.sessions), sub: "Chats mit Claude" },
    { icon: FolderPlus, label: "Projekte", value: formatCount(c.projectsCreated), sub: "in FORGE angelegt" },
    { icon: Bot, label: "Parallele Agenten", value: formatCount(c.agentsStarted), sub: `${formatCount(c.agentsMerged)} zusammengeführt` },
    { icon: Phone, label: "Telefonate", value: formatCount(c.phoneCalls), sub: "über die Telefon-Funktion" },
    { icon: MonitorDown, label: "Installationen", value: formatCount(t.installs), sub: `${formatCount(t.activeInstalls30d)} aktiv in 30 Tagen` },
    { icon: Wifi, label: "Gerade online", value: formatCount(t.onlineInstalls), sub: `Meldung in den letzten ${ONLINE_MINUTES} Min.` },
  ];
}

// Labels and icons of the tiles while the numbers load.
const TILE_SHAPES = tiles({
  installs: 0,
  activeInstalls30d: 0,
  onlineInstalls: 0,
  counters: Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as Counters,
  updatedAt: new Date(0).toISOString(),
  models: {},
  versions: [],
  plans: [],
  history: [],
});

const TOKEN_ROWS = [
  { key: "tokensInput", icon: ArrowUpFromLine, label: "Eingabe", description: "Text, den FORGE an Claude geschickt hat" },
  { key: "tokensOutput", icon: ArrowDownToLine, label: "Ausgabe", description: "Antworten und Werkzeugaufrufe von Claude" },
  { key: "tokensCacheRead", icon: Database, label: "Cache gelesen", description: "Aus dem Prompt-Cache, günstiger als neue Eingabe" },
  { key: "tokensCacheWrite", icon: DatabaseZap, label: "Cache geschrieben", description: "Neu in den Prompt-Cache gelegt" },
] as const;

export type PageState = { kind: "loading" } | { kind: "error" } | { kind: "ok"; totals: Totals };

export function StatsPage({ state }: { state: PageState }) {
  const totals = state.kind === "ok" ? state.totals : null;
  const loading = state.kind === "loading";

  return (
    <main className="container content">
      <div className="intro">
        <h1>FORGE in Zahlen</h1>
        <p>FORGE ist eine Desktop-Oberfläche für Claude Code. Hier stehen die Summen aller Installationen, die anonyme Nutzungszahlen senden.</p>
      </div>

      {state.kind === "error" ? (
        <div className="error-banner" role="alert">
          <TriangleAlert aria-hidden />
          <div>
            <div className="error-title">Die Zahlen sind gerade nicht abrufbar</div>
            <div>Die Datenbank antwortet nicht. Bitte versuche es in ein paar Minuten noch einmal.</div>
          </div>
        </div>
      ) : (
        <>
          <section aria-labelledby="figures" aria-busy={loading || undefined}>
            <SectionTitle
              action={
                <span className="section-meta">{totals ? `Stand ${formatDateTime(totals.updatedAt)} Uhr` : <Skeleton width="9rem" />}</span>
              }
            >
              <span id="figures">Kennzahlen</span>
            </SectionTitle>
            <div className="tiles">
              {totals
                ? tiles(totals).map((t) => <Tile key={t.label} {...t} />)
                : TILE_SHAPES.map((t, i) => (
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
              Modelle und Kosten melden erst neuere FORGE-Versionen. Claude-Aufrufe davor zählen bei Tokens und Durchläufen, fehlen aber im Wert in API-Preisen. Der größte Teil
              der Tokens kommt aus dem Prompt-Cache, der nur einen Bruchteil neuer Eingabe kostet.
            </p>
          </section>

          {totals ? <StatsCharts totals={totals} /> : <ChartsSkeleton />}

          <Group title="Tokens im Detail" description="Alle Claude-Anfragen aus FORGE, nach Art der Tokens">
            {TOKEN_ROWS.map((r, i) => (
              <Row key={r.key} icon={r.icon} label={r.label} description={r.description}>
                {totals ? formatCount(totals.counters[r.key]) : <Skeleton width={`${4 + ((i * 3) % 3)}rem`} />}
              </Row>
            ))}
          </Group>
        </>
      )}

      <Group title="Was erfasst wird" description="Abschaltbar in FORGE unter Einstellungen > Über FORGE > Datenschutz">
        <Row
          icon={Send}
          label="Gemeldet"
          description="Alle 5 Minuten die Gesamtzähler: Tokens, Arbeitszeit, Durchläufe, Sessions, Projekte, Agenten und Telefonate. Dazu eine zufällige Installations-ID, die FORGE-Version, das Betriebssystem und die Art des Claude-Abos (zum Beispiel Pro oder Max 5x)."
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
