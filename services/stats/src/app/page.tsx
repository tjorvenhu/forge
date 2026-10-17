import { getTotals, type Totals } from "@/lib/db";
import { formatCount, formatDateTime, formatHours } from "@/lib/format";

// Rendered per request; getTotals() caches the sums for five minutes.
export const dynamic = "force-dynamic";

const REPO_URL = "https://github.com/tjorvenhu/forge";
const DONATE_URL = "https://paypal.me/tjorvenhu";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function Figures({ totals }: { totals: Totals }) {
  const c = totals.counters;
  return (
    <>
      <section className="hero" aria-labelledby="tokens">
        <h2 id="tokens" className="hero-label">
          Tokens gesamt
        </h2>
        <div className="hero-value">{formatCount(c.tokensInput + c.tokensOutput)}</div>
        <p className="hero-note">Eingabe und Ausgabe aller Claude-Anfragen aus FORGE.</p>
        <dl className="breakdown">
          <div>
            <dt>Eingabe</dt>
            <dd>{formatCount(c.tokensInput)}</dd>
          </div>
          <div>
            <dt>Ausgabe</dt>
            <dd>{formatCount(c.tokensOutput)}</dd>
          </div>
          <div>
            <dt>Cache gelesen</dt>
            <dd>{formatCount(c.tokensCacheRead)}</dd>
          </div>
          <div>
            <dt>Cache geschrieben</dt>
            <dd>{formatCount(c.tokensCacheWrite)}</dd>
          </div>
        </dl>
      </section>

      <section className="grid" aria-label="Weitere Zahlen">
        <Stat label="Stunden Claude-Arbeitszeit" value={formatHours(c.claudeWorkMs)} />
        <Stat label="Durchläufe" value={formatCount(c.claudeTurns)} />
        <Stat label="Sessions" value={formatCount(c.sessions)} />
        <Stat label="Angelegte Projekte" value={formatCount(c.projectsCreated)} />
        <Stat label="Gestartete Agenten" value={formatCount(c.agentsStarted)} />
        <Stat label="Zusammengeführte Agenten" value={formatCount(c.agentsMerged)} />
        <Stat label="Telefonate" value={formatCount(c.phoneCalls)} />
        <Stat
          label="Installationen"
          value={formatCount(totals.installs)}
          note={`davon ${formatCount(totals.activeInstalls30d)} aktiv in den letzten 30 Tagen`}
        />
      </section>

      <p className="updated">Stand: {formatDateTime(totals.updatedAt)} Uhr. Die Zahlen werden alle 5 Minuten neu berechnet.</p>
    </>
  );
}

export default async function Home() {
  let totals: Totals | null = null;
  try {
    totals = await getTotals();
  } catch (err) {
    console.error("totals failed:", err instanceof Error ? err.message : err);
  }

  return (
    <main className="page">
      <header>
        <h1>FORGE in Zahlen</h1>
        <p className="lead">
          FORGE ist eine Desktop-Oberfläche für Claude Code. Hier stehen die Summen aller Installationen, die anonyme
          Nutzungszahlen senden.
        </p>
      </header>

      {totals ? (
        <Figures totals={totals} />
      ) : (
        <div className="notice" role="status">
          <strong>Die Zahlen sind gerade nicht abrufbar.</strong> Die Datenbank antwortet nicht. Bitte versuche es in
          ein paar Minuten noch einmal.
        </div>
      )}

      <section className="privacy" aria-labelledby="privacy">
        <h2 id="privacy">Was erfasst wird</h2>
        <p>
          Jede Installation meldet höchstens einmal täglich ihre Gesamtzähler: Tokens, Arbeitszeit, Durchläufe, Sessions,
          Projekte, Agenten und Telefonate. Dazu kommen eine zufällige Installations-ID, die FORGE-Version und das
          Betriebssystem.
        </p>
        <p>
          Nicht erfasst werden Inhalte von Nachrichten, Dateien, Projektnamen und IP-Adressen. Abschalten lässt sich die
          Statistik in FORGE unter Einstellungen &gt; Über FORGE &gt; Datenschutz. Dabei wird auch der gespeicherte
          Datensatz dieser Installation gelöscht.
        </p>
      </section>

      <footer className="links">
        <a href={REPO_URL}>FORGE auf GitHub</a>
        <a href={DONATE_URL}>Entwicklung unterstützen</a>
      </footer>
    </main>
  );
}
