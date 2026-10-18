/** German texts (core.knowledge). Source of the keys: the English file is typed against this one. */
export const knowledge = {
  invalidId: (id: string) => `Ungültige Kennung „${id}“.`,
  notFound: (id: string) => `Kein Eintrag „${id}“.`,
  mergeNeedsTwo: "Zum Zusammenführen braucht es mindestens zwei verschiedene Einträge.",
  nothingToFix: "Alle Verweise des Eintrags gibt es im Projekt. Da ist nichts zu korrigieren.",

  schemaTitle: "kurzer Titel mit den Suchbegriffen, höchstens 100 Zeichen",
  schemaSummary: "ein Satz, höchstens 250 Zeichen",
  schemaTags: "2 bis 6 Stichwörter in Kleinbuchstaben",
  schemaContent: "der zusammengeführte Eintrag in Markdown",
  schemaPlanIds: "Kennungen der Einträge; der erste bleibt bestehen, die anderen gehen in ihm auf",
  schemaPlanReason: "ein kurzer Satz, warum diese Einträge dasselbe Thema behandeln",

  /** Field labels of an entry inside the prompts. */
  entryHeader: (id: string, date: string) => `=== Eintrag ${id} (Stand ${date}) ===`,
  fieldTitle: "Titel",
  fieldSummary: "Zusammenfassung",
  fieldTags: "Tags",
  fieldOutline: "Gliederung",

  mergePrompt: [
    "Führe diese Einträge aus dem Projektwissen eines Softwareprojekts zu einem einzigen Eintrag zusammen.",
    "- Erhalte alles Wissen: Dateipfade, Befehle, Begründungen, Stolperfallen, Daten. Lass nur Doppeltes weg.",
    "- Widersprechen sich Einträge, gilt der mit dem neueren Stand.",
    "- Nichts erfinden, nichts hinzufügen, was nicht in den Einträgen steht.",
    "- Titel: kurz, mit den Begriffen, unter denen man ihn sucht (Code-Namen gern in Klammern).",
    "- Zusammenfassung: ein Satz, worum es geht und wann man den Eintrag braucht.",
    "- Tags: 2 bis 6, aus denen der Einträge.",
    "- Inhalt: Markdown, beginnt mit '# <Titel>', danach Abschnitte mit '##'. Sprache wie in den Einträgen.",
  ],

  mergePlanPrompt: (maxGroup: number, maxChars: number) => [
    "Prüfe das Projektwissen eines Softwareprojekts: Welche Einträge behandeln dasselbe Thema und sollten zu einem Eintrag zusammengeführt werden?",
    "- Nur Einträge, die wirklich dasselbe Thema behandeln oder sich inhaltlich doppeln. Derselbe Bereich (z. B. beide UI) oder gleiche Tags reichen nicht.",
    `- Höchstens ${maxGroup} Einträge pro Gruppe, jeder Eintrag in höchstens einer Gruppe.`,
    `- Zusammen höchstens etwa ${maxChars} Zeichen (Summe der Längen), sonst wird der neue Eintrag zu lang.`,
    "- Der erste Eintrag einer Gruppe bleibt bestehen: nimm den umfassendsten.",
    "- Passt nichts zusammen, gib eine leere Liste zurück. Lieber eine Gruppe zu wenig als eine erzwungene.",
  ],
  mergePlanPairs: "Ein lokaler Wortvergleich hält diese Paare für ähnlich (nur ein Hinweis, prüfe selbst):",
  mergePlanEntryHeader: (id: string, chars: number) => `=== ${id} (${chars} Zeichen) ===`,

  fixPrompt: [
    "Dieser Eintrag aus dem Projektwissen eines Softwareprojekts verweist auf Dateien, Ordner oder Bezeichner, die es im Projekt nicht mehr gibt. Korrigiere ihn.",
    "- Ersetze veraltete Verweise durch die aktuellen, wenn die Hinweise unten eindeutig zeigen, wohin etwas verschoben oder wie es umbenannt wurde.",
    "- Ist nicht eindeutig, was an die Stelle getreten ist, entferne die Aussage oder kennzeichne sie knapp als veraltet. Nicht raten.",
    "- Alles andere bleibt unverändert: Aufbau, Begründungen, Stolperfallen, Sprache und Ton.",
    "- Nichts erfinden, nichts hinzufügen, was weder im Eintrag noch in den Hinweisen steht.",
    "- Titel, Zusammenfassung und Tags nur anpassen, wenn sie selbst veraltete Namen enthalten.",
    "- Inhalt: Markdown wie bisher, beginnt mit '# <Titel>'.",
  ],
  fixMissing: (refs: string) => `Fehlende Verweise: ${refs}`,
  fixHints: "Hinweise aus dem Projekt:",
  none: "(keine)",

  /** Hints of the reference check (staleness.ts). */
  lastChangedIn: (hash: string, subject: string) => `zuletzt geändert in ${hash}: ${subject}`,
  seenEarlier: "war bei einer früheren Prüfung noch im Projekt",
  sameName: (names: string) => `gleicher Name: ${names}`,
  refPath: "Pfad",
  refName: "Bezeichner",
  changesIn: (hash: string) => `Änderungen in ${hash}, die ihn betreffen:`,
  filesIn: (hash: string) => `Dateien in ${hash}:`,
  gitGrepFailed: (code: number | null) => `git grep fehlgeschlagen (Code ${code})`,
};
