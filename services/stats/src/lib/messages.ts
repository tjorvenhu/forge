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
    screenshotAlt: "FORGE mit einer neuen Session im Projekt forge: Seitenleiste, Reiter und Eingabefeld mit einem Auftrag an Claude",
    features: {
      projects: { title: "Projekte verwalten", text: "Alle Sessions, Dateien und Einstellungen an einem Ort." },
      ui: { title: "Intuitive Oberfläche", text: "Chat, Agenten und Tools übersichtlich vereint." },
      git: { title: "Git Integration", text: "Automatische Commits, Branches und PRs." },
      workflow: { title: "Dein Workflow", text: "Anpassbar, erweiterbar\nund auf dich zugeschnitten." },
    },
  },
  stats: {
    eyebrow: "Live Stats",
    title: "FORGE in",
    titleAccent: "Zahlen",
    lead: "Aktuelle Statistiken zur anonymen Nutzung von Forge.\nGezählt wird seit dem 17. Oktober 2026.",
    live: "Live",
    liveTitle: "Die Zahlen aktualisieren sich von selbst",
    updated: (at: string) => `Letzte Aktualisierung: ${at} Uhr`,
    tiles: {
      tokens: "Tokens",
      tokensSub: "alle Token über FORGE",
      sessions: "Sessions",
      sessionsSub: "Chats mit Claude",
      turns: "Durchläufe",
      turnsSub: "Aufträge an Claude",
      workTime: "Arbeitszeit",
      hoursUnit: "Std.",
      workTimeSub: "Laufzeit aller Durchläufe",
      cost: "Kosten",
      costSub: "geschätzt, zu API-Preisen",
      online: "Gerade online",
      onlineSub: (minutes: number) => `Meldung in den letzten ${minutes} Min.`,
      sparkTitle: "Verlauf der letzten 7 Tage",
    },
    charts: {
      empty: "Noch keine Daten",
      today: (day: string) => `${day}, heute`,
      tokens: (n: string) => `${n} Tokens`,
      turns: (n: number, text: string) => `${text} ${n === 1 ? "Durchlauf" : "Durchläufe"}`,
      installs: (n: number, text: string) => `${text} ${n === 1 ? "Installation" : "Installationen"}`,
      range: "Zeitraum",
      lastDays: (days: number) => `Letzte ${days} Tage`,
      tokensPerDay: "Tokens pro Tag",
      tokensPerDaySub: "Alle Token-Arten, Tage in UTC",
      activePerDay: "Aktive Installationen",
      activePerDaySub: "Installationen mit Meldung am Tag",
      topModels: "Top Modelle",
      topModelsSub: "Verteilung der verwendeten Modelle",
      otherModels: "Andere",
      platforms: "Plattformen",
      platformsSub: "Betriebssysteme der Nutzer",
      platformNames: { windows: "Windows 10/11", macos: "macOS", linux: "Linux", other: "Andere" },
      platformTotal: (n: number): string => (n === 1 ? "Installation" : "Installationen"),
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
    text: "FORGE ist Open Source und kostenlos. Ein Beitrag hilft bei der Weiterentwicklung.",
    donated: "Bisher gespendet",
    contributions: (n: number, text: string) => `${text} ${n === 1 ? "Beitrag" : "Beiträge"}, vor Gebühren`,
    note: "Betrag frei wählbar. Das Geld geht an die Vanturis UG, eine Spendenquittung gibt es nicht.",
    pay: "Beitrag über Stripe",
    feedback: "Idee oder Fehler melden",
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
    screenshotAlt: "FORGE with a new session in the project forge: sidebar, tabs and the message box with a task for Claude",
    features: {
      projects: { title: "Manage projects", text: "All sessions, files and settings in one place." },
      ui: { title: "Intuitive interface", text: "Chat, agents and tools clearly combined." },
      git: { title: "Git integration", text: "Automatic commits, branches and PRs." },
      workflow: { title: "Your workflow", text: "Adaptable, extensible and tailored to you." },
    },
  },
  stats: {
    eyebrow: "Live Stats",
    title: "FORGE in",
    titleAccent: "numbers",
    lead: "Current statistics on the anonymous use of Forge.\nCounting since October 17, 2026.",
    live: "Live",
    liveTitle: "The numbers update on their own",
    updated: (at: string) => `Last update: ${at}`,
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
      cost: "Cost",
      costSub: "estimated, at API prices",
      online: "Online now",
      onlineSub: (minutes: number) => `reported in the last ${minutes} min`,
      sparkTitle: "Last 7 days",
    },
    charts: {
      empty: "No data yet",
      today: (day: string) => `${day}, today`,
      tokens: (n: string) => `${n} tokens`,
      turns: (n: number, text: string) => `${text} ${n === 1 ? "run" : "runs"}`,
      installs: (n: number, text: string) => `${text} ${n === 1 ? "installation" : "installations"}`,
      range: "Period",
      lastDays: (days: number) => `Last ${days} days`,
      tokensPerDay: "Tokens per day",
      tokensPerDaySub: "All token types, days in UTC",
      activePerDay: "Active installations",
      activePerDaySub: "Installations with a report that day",
      topModels: "Top models",
      topModelsSub: "Share of the models used",
      otherModels: "Other",
      platforms: "Platforms",
      platformsSub: "Operating systems of the users",
      platformNames: { windows: "Windows 10/11", macos: "macOS", linux: "Linux", other: "Other" },
      platformTotal: (n: number) => (n === 1 ? "installation" : "installations"),
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
    text: "FORGE is open source and free. A contribution helps its development.",
    donated: "Donated so far",
    contributions: (n: number, text: string) => `${text} ${n === 1 ? "contribution" : "contributions"}, before fees`,
    note: "Any amount you like. The money goes to Vanturis UG; there is no donation receipt.",
    pay: "Contribute via Stripe",
    feedback: "Idea or bug report",
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
