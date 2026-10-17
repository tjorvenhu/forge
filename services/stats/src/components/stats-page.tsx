import { ArrowDownToLine, ArrowUpFromLine, Bot, Clock, Coins, Database, DatabaseZap, EyeOff, FolderPlus, MessagesSquare, MonitorDown, Phone, Power, Repeat, Send, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Totals } from "@/lib/db";
import { COUNTER_KEYS, type Counters } from "@/lib/report";
import { formatCount, formatDateTime, formatHours } from "@/lib/format";
import { Group, Row, SectionTitle, Skeleton, Tile } from "./blocks";

type TileDef = { icon: LucideIcon; label: string; value: string; unit?: string; sub: string; highlight?: boolean };

function tiles(t: Totals): TileDef[] {
  const c = t.counters;
  return [
    // Same count as the app (sidebar, daily report): every token Claude processed, the cached context included.
    {
      icon: Coins,
      label: "Tokens gesamt",
      value: formatCount(c.tokensInput + c.tokensOutput + c.tokensCacheRead + c.tokensCacheWrite),
      sub: `davon ${formatCount(c.tokensInput + c.tokensOutput + c.tokensCacheWrite)} neu, der Rest Kontext aus dem Cache`,
      highlight: true,
    },
    { icon: Clock, label: "Claude-Arbeitszeit", value: formatHours(c.claudeWorkMs), unit: "Std.", sub: "Laufzeit aller Durchläufe" },
    { icon: Repeat, label: "Durchläufe", value: formatCount(c.claudeTurns), sub: "Aufträge an Claude" },
    { icon: MessagesSquare, label: "Sessions", value: formatCount(c.sessions), sub: "Chats mit Claude" },
    { icon: FolderPlus, label: "Projekte", value: formatCount(c.projectsCreated), sub: "in FORGE angelegt" },
    { icon: Bot, label: "Parallele Agenten", value: formatCount(c.agentsStarted), sub: `${formatCount(c.agentsMerged)} zusammengeführt` },
    { icon: Phone, label: "Telefonate", value: formatCount(c.phoneCalls), sub: "über die Telefon-Funktion" },
    { icon: MonitorDown, label: "Installationen", value: formatCount(t.installs), sub: `${formatCount(t.activeInstalls30d)} aktiv in 30 Tagen` },
  ];
}

// Labels and icons of the tiles while the numbers load.
const TILE_SHAPES = tiles({
  installs: 0,
  activeInstalls30d: 0,
  counters: Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as Counters,
  updatedAt: new Date(0).toISOString(),
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
                    <div key={t.label} className="tile">
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
          </section>

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
          description="Alle 5 Minuten die Gesamtzähler: Tokens, Arbeitszeit, Durchläufe, Sessions, Projekte, Agenten und Telefonate. Dazu eine zufällige Installations-ID, die FORGE-Version und das Betriebssystem."
        />
        <Row icon={EyeOff} label="Nicht erfasst" description="Inhalte von Nachrichten, Dateien, Projektnamen und IP-Adressen." />
        <Row icon={Power} label="Abschalten" description="Wer die Statistik abschaltet, löscht damit auch den gespeicherten Datensatz seiner Installation." />
      </Group>

      <p className="footnote">Die Summen werden alle 5 Minuten neu berechnet.</p>
    </main>
  );
}
