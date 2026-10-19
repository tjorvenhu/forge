import { formats, type Formats } from "./format";
import type { Locale } from "./i18n";

// Every visible text of the page. German is the source; `en` must have exactly the same keys (typeof de).
// Texts with values are functions that get them already formatted and solve the plural themselves.

const de = {
  meta: {
    title: "FORGE, die Desktop-App für Claude Code",
    description:
      "FORGE ist ein modernes Desktop-Tool für Claude Code. Verwalte Projekte, Sessions und Git in einer übersichtlichen Oberfläche statt im Terminal. Open Source, für Windows.",
  },
  statsMeta: {
    title: "FORGE Live Stats",
    description: "Gesamtzahlen aller FORGE-Installationen, die anonyme Nutzungszahlen senden.",
  },
  header: {
    home: "FORGE, zur Startseite",
    nav: "Seiten",
    liveStats: "Live Stats",
    github: "GitHub",
    download: "Download",
  },
  landing: {
    eyebrow: "Claude Development Studio",
    title: "Deine AI",
    titleAccent: "Entwicklungszentrale",
    lead: "Forge ist ein modernes Desktop-Tool für Claude Code. Verwalte Projekte, Sessions und Git, mit einer intuitiven Oberfläche statt Terminal.",
    download: "Jetzt herunterladen",
    liveStats: "Live Stats ansehen",
    facts: { windows: "Windows 10/11", openSource: "Open Source", earlyAccess: "Early Access" },
    screenshotAlt: "FORGE mit der Projektübersicht: Projekte mit Git-Status, Tags und einem laufenden Agenten",
    features: {
      projects: { title: "Projekte verwalten", text: "Alle Sessions, Dateien und Einstellungen an einem Ort." },
      ui: { title: "Intuitive Oberfläche", text: "Chat, Agenten und Tools übersichtlich vereint." },
      git: { title: "Git Integration", text: "Automatische Commits, Branches und PRs." },
      workflow: { title: "Dein Workflow", text: "Anpassbar, erweiterbar\nund auf dich zugeschnitten." },
    },
  },
  stats: {
    eyebrow: "Live Stats",
    title: "FORGE in Zahlen",
    lead: "Summen aller Installationen, bei denen die anonyme Nutzungsstatistik eingeschaltet ist. Gezählt wird seit dem 17. Oktober 2026.",
    live: "Live",
    liveTitle: "Die Zahlen aktualisieren sich von selbst",
    updated: (at: string) => `Stand ${at} Uhr`,
    tiles: {
      tokens: "Tokens",
      tokensSub: "alle Tokens über FORGE",
      sessions: "Sessions",
      sessionsSub: "Chats mit Claude",
      turns: "Durchläufe",
      turnsSub: "Aufträge an Claude",
      workTime: "Arbeitszeit",
      hoursUnit: "Std.",
      workTimeSub: "Laufzeit aller Durchläufe",
      projects: "Projekte",
      projectsSub: "in FORGE angelegt",
      agents: "Agenten",
      agentsMerged: (n: string) => `${n} zusammengeführt`,
      installs: "Installationen",
      installsActive: (n: string) => `${n} aktiv in 30 Tagen`,
      online: "Gerade online",
      onlineSub: (minutes: number) => `Meldung in den letzten ${minutes} Min.`,
    },
    charts: {
      empty: "Noch keine Daten",
      more: (n: number) => `und ${n} weitere`,
      today: (day: string) => `${day}, heute`,
      tokens: (n: string) => `${n} Tokens`,
      turns: (n: number, text: string) => `${text} ${n === 1 ? "Durchlauf" : "Durchläufe"}`,
      installs: (n: number, text: string) => `${text} ${n === 1 ? "Installation" : "Installationen"}`,
      history: "Letzte 30 Tage",
      tokensPerDay: "Tokens pro Tag",
      tokensPerDaySub: "Alle Token-Arten, Tage in UTC",
      activePerDay: "Aktive Installationen",
      activePerDaySub: "Installationen mit Meldung am Tag",
      tokensByModel: "Tokens nach Modell",
      tokensByModelSub: "Nur neuere FORGE-Versionen melden das Modell",
      modelDetail: (share: string) => `${share} der Tokens`,
    },
    privacy: {
      title: "Was erfasst wird",
      text: "In FORGE standardmäßig aus. Ein- und ausschalten unter Einstellungen > Über FORGE > Datenschutz.",
      items: {
        off: { title: "Standardmäßig aus", text: "FORGE fragt einmal nach. Solange die Statistik aus ist, sendet die App nichts." },
        anonymous: { title: "Anonym", text: "Alle 5 Minuten die Gesamtzähler mit einer zufälligen Installations-ID, Version und Betriebssystem." },
        notCollected: { title: "Nicht erfasst", text: "Keine Inhalte von Nachrichten, keine Dateien, Projektnamen oder IP-Adressen." },
        delete: { title: "Abschalten löscht", text: "Wer die Statistik abschaltet, löscht damit den gespeicherten Datensatz seiner Installation." },
      },
    },
    footnote: "Die Summen werden alle 5 Minuten neu berechnet. Tage beginnen um 0 Uhr UTC.",
  },
  unavailable: {
    title: "Die Zahlen sind gerade nicht abrufbar",
    text: "Die Datenbank antwortet nicht. Bitte versuche es in ein paar Minuten noch einmal.",
  },
  language: {
    label: "Sprache",
  },
  footer: {
    license: "FORGE ist ein Open-Source-Produkt der Vanturis UG (haftungsbeschränkt), lizenziert unter AGPL-3.0.",
    imprint: "Impressum",
    privacy: "Datenschutz",
  },
  support: {
    button: "Unterstützen",
    title: "FORGE unterstützen",
    close: "Schließen",
    text: "FORGE ist ein Open-Source-Produkt der Vanturis UG. Wenn es dir hilft, kannst du die Weiterentwicklung mit einem freiwilligen Beitrag unterstützen oder Verbesserungen vorschlagen.",
    donated: "Bisher gespendet",
    contributions: (n: number, text: string) => `${text} ${n === 1 ? "Beitrag" : "Beiträge"}, vor Gebühren`,
    note: "Den Betrag wählst du selbst. Das Geld geht an die Vanturis UG, die FORGE entwickelt. Sie ist nicht gemeinnützig, eine Spendenquittung gibt es deshalb nicht.",
    pay: "Beitrag über Stripe zahlen",
    feedback: "Vorschlag oder Fehler melden",
    feedbackTitle: "Als Issue auf GitHub, mit GitHub-Konto",
  },
  notFound: {
    title: "Seite nicht gefunden",
    text: "Unter dieser Adresse gibt es nichts.",
    back: "Zur Startseite",
  },
  error: {
    title: "Etwas ist schiefgelaufen",
    text: "Die Seite konnte nicht geladen werden. Bitte versuche es in ein paar Minuten noch einmal.",
    retry: "Erneut versuchen",
  },
};

export type Messages = typeof de;

const en: Messages = {
  meta: {
    title: "FORGE, the desktop app for Claude Code",
    description:
      "FORGE is a modern desktop tool for Claude Code. Manage projects, sessions and Git in a clear interface instead of the terminal. Open source, for Windows.",
  },
  statsMeta: {
    title: "FORGE Live Stats",
    description: "Totals of all FORGE installations that send anonymous usage numbers.",
  },
  header: {
    home: "FORGE, to the home page",
    nav: "Pages",
    liveStats: "Live Stats",
    github: "GitHub",
    download: "Download",
  },
  landing: {
    eyebrow: "Claude Development Studio",
    title: "Your AI",
    titleAccent: "Development Hub",
    lead: "Forge is a modern desktop tool for Claude Code. Manage projects, sessions and Git, with an intuitive interface instead of the terminal.",
    download: "Download now",
    liveStats: "View live stats",
    facts: { windows: "Windows 10/11", openSource: "Open Source", earlyAccess: "Early Access" },
    screenshotAlt: "FORGE showing the projects overview: projects with Git status, tags and a running agent",
    features: {
      projects: { title: "Manage projects", text: "All sessions, files and settings in one place." },
      ui: { title: "Intuitive interface", text: "Chat, agents and tools clearly combined." },
      git: { title: "Git integration", text: "Automatic commits, branches and PRs." },
      workflow: { title: "Your workflow", text: "Adaptable, extensible and tailored to you." },
    },
  },
  stats: {
    eyebrow: "Live Stats",
    title: "FORGE in numbers",
    lead: "Totals of all installations with anonymous usage statistics turned on. Counting since October 17, 2026.",
    live: "Live",
    liveTitle: "The numbers update on their own",
    updated: (at: string) => `Updated ${at}`,
    tiles: {
      tokens: "Tokens",
      tokensSub: "every token through FORGE",
      sessions: "Sessions",
      sessionsSub: "chats with Claude",
      turns: "Runs",
      turnsSub: "tasks for Claude",
      workTime: "Working time",
      hoursUnit: "h",
      workTimeSub: "runtime of all runs",
      projects: "Projects",
      projectsSub: "created in FORGE",
      agents: "Agents",
      agentsMerged: (n: string) => `${n} merged`,
      installs: "Installations",
      installsActive: (n: string) => `${n} active in 30 days`,
      online: "Online now",
      onlineSub: (minutes: number) => `reported in the last ${minutes} min`,
    },
    charts: {
      empty: "No data yet",
      more: (n: number) => `and ${n} more`,
      today: (day: string) => `${day}, today`,
      tokens: (n: string) => `${n} tokens`,
      turns: (n: number, text: string) => `${text} ${n === 1 ? "run" : "runs"}`,
      installs: (n: number, text: string) => `${text} ${n === 1 ? "installation" : "installations"}`,
      history: "Last 30 days",
      tokensPerDay: "Tokens per day",
      tokensPerDaySub: "All token types, days in UTC",
      activePerDay: "Active installations",
      activePerDaySub: "Installations with a report that day",
      tokensByModel: "Tokens by model",
      tokensByModelSub: "Only newer FORGE versions report the model",
      modelDetail: (share: string) => `${share} of tokens`,
    },
    privacy: {
      title: "What is collected",
      text: "Off by default in FORGE. Turn it on or off under Settings > About FORGE > Privacy.",
      items: {
        off: { title: "Off by default", text: "FORGE asks once. While the statistics are off, the app sends nothing." },
        anonymous: { title: "Anonymous", text: "Every 5 minutes the running totals with a random installation ID, version and operating system." },
        notCollected: { title: "Not collected", text: "No message contents, files, project names or IP addresses." },
        delete: { title: "Turning off deletes", text: "Turning the statistics off also deletes the stored record of that installation." },
      },
    },
    footnote: "Totals are recalculated every 5 minutes. Days start at 00:00 UTC.",
  },
  unavailable: {
    title: "The numbers are unavailable right now",
    text: "The database is not responding. Please try again in a few minutes.",
  },
  language: {
    label: "Language",
  },
  footer: {
    license: "FORGE is an open-source product of Vanturis UG (haftungsbeschränkt), licensed under AGPL-3.0.",
    imprint: "Legal notice",
    privacy: "Privacy policy",
  },
  support: {
    button: "Support",
    title: "Support FORGE",
    close: "Close",
    text: "FORGE is an open-source product of Vanturis UG. If it helps you, you can support its development with a voluntary contribution or suggest improvements.",
    donated: "Donated so far",
    contributions: (n: number, text: string) => `${text} ${n === 1 ? "contribution" : "contributions"}, before fees`,
    note: "You choose the amount. The money goes to Vanturis UG, which develops FORGE. It is not a charity, so there is no donation receipt.",
    pay: "Contribute via Stripe",
    feedback: "Suggest an idea or report a bug",
    feedbackTitle: "As a GitHub issue, requires a GitHub account",
  },
  notFound: {
    title: "Page not found",
    text: "There is nothing at this address.",
    back: "Back to the home page",
  },
  error: {
    title: "Something went wrong",
    text: "The page could not be loaded. Please try again in a few minutes.",
    retry: "Try again",
  },
};

const MESSAGES: Record<Locale, Messages> = { de, en };

/** Each language's name in itself, for the switch. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", de: "Deutsch" };

/** Texts and formats of one language; server components call it directly, client ones through useI18n(). */
export function i18n(locale: Locale): { locale: Locale; t: Messages; f: Formats } {
  return { locale, t: MESSAGES[locale], f: formats(locale) };
}
