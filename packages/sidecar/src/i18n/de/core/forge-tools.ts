/** German texts (core.forgeTools). Source of the keys: the English file is typed against this one. */
export const forgeTools = {
  // knowledge_search
  knowledgeSearchDescription:
    "Durchsucht das Projektwissen (Titel, Tags, Zusammenfassung, Text). Liefert Kennung, Titel, Zusammenfassung und eine Textstelle je Treffer.",
  knowledgeSearchQuery: "Suchwörter, z. B. 'migration prisma' oder 'deploy coolify'",
  knowledgeSearchNone: "Keine Treffer im Projektwissen.",
  knowledgeSearchStale: (refs: string) => `Veraltet, gibt es nicht mehr: ${refs}`,
  // knowledge_read
  knowledgeReadDescription: "Liest einen Eintrag des Projektwissens vollständig.",
  knowledgeReadId: "Kennung aus dem Index oder knowledge_search",
  knowledgeReadStale: (refs: string) =>
    `Veraltet: Diese Verweise gibt es im Projekt nicht mehr: ${refs}. Verlass dich an diesen Stellen nicht auf den Eintrag, prüfe den Code und korrigiere den Eintrag mit knowledge_save.`,
  knowledgeReadSummary: "Zusammenfassung",
  knowledgeReadTags: "Tags",
  knowledgeReadNoTags: "keine",
  knowledgeReadUpdated: "Stand",
  // entry fields
  entryTitle:
    "Kurzer, eindeutiger Titel mit den Begriffen, unter denen man ihn sucht, z. B. 'Rechtsklick-Menü (ContextMenuHost, addContextItems)'. Steht so im Index jeder Session",
  entrySummary: "Ein kurzer Satz: worum es geht und wann man den Eintrag braucht",
  entryTags: (known: string[]) =>
    `2 bis 5 Stichwörter in Kleinbuchstaben: Bereich und Art (z. B. stolperfalle, konvention). ${known.length ? `Vorhandene wiederverwenden: ${known.join(", ")}` : ""}`.trim(),
  entryContent: "Inhalt in Markdown: konkret, mit Dateipfaden, Befehlen und Begründungen. Beim Aktualisieren der vollständige neue Text",
  overlapHint: (near: string) => ` Überschneidet sich stark mit: ${near}. Ist es dasselbe Thema, führe die Einträge mit knowledge_merge zusammen.`,
  // knowledge_save
  knowledgeSaveDescription:
    "Legt einen Eintrag im Projektwissen an oder aktualisiert ihn (mit id). Für dauerhaft nützliches Wissen, das nicht offensichtlich im Code steht. Ein Eintrag pro Thema; bestehende Einträge ergänzen statt Duplikate anlegen.",
  knowledgeSaveId: "Kennung eines bestehenden Eintrags zum Aktualisieren; leer legt einen neuen an",
  knowledgeSaveForce: "true legt trotz eines ähnlichen Eintrags einen neuen an",
  knowledgeSaveSimilar: (near: string) =>
    `Nicht gespeichert: Es gibt schon ähnliche Einträge: ${near}. Lies sie mit knowledge_read und aktualisiere den passenden mit id, oder setze force=true, wenn es wirklich ein anderes Thema ist.`,
  knowledgeSaved: (updated: boolean, id: string, file: string) => `${updated ? "Aktualisiert" : "Gespeichert"}: ${id} (${file}).`,
  // knowledge_merge
  knowledgeMergeDescription:
    "Führt Einträge des Projektwissens, die dasselbe Thema behandeln, zu einem zusammen: der erste behält seine Kennung und bekommt den neuen Text, die übrigen werden gelöscht. Lies vorher alle mit knowledge_read; content muss das Wissen aller Einträge enthalten, Doppeltes und Veraltetes fällt weg.",
  knowledgeMergeIds: "Kennungen der Einträge; der erste bleibt bestehen",
  knowledgeMerged: (id: string, file: string, removed: string) => `Zusammengeführt: ${id} (${file}). Gelöscht: ${removed}.`,
  // knowledge_delete
  knowledgeDeleteDescription: "Löscht einen veralteten oder falschen Eintrag des Projektwissens.",
  knowledgeDeleted: (id: string) => `Gelöscht: ${id}`,
  knowledgeNoEntry: (id: string) => `Kein Eintrag ${id}.`,
  // knowledge_check
  knowledgeCheckDescription:
    "Prüft das Projektwissen auf veraltete Verweise: Pfade, Dateinamen und Bezeichner aus den Einträgen, die es im Projekt nicht mehr gibt (dieselbe Prüfung wie im Wissen-Tab). Liefert je betroffenem Eintrag die fehlenden Verweise mit Hinweis, wohin sie gingen.",
  knowledgeCheckIds: "Nur diese Einträge prüfen; leer prüft alle",
  knowledgeCheckRefresh: "true verwirft den Zwischenspeicher und prüft neu",
  knowledgeCheckNone: (checked: number) => `Keine veralteten Verweise (${checked === 1 ? "1 Eintrag" : `${checked} Einträge`} geprüft).`,
  knowledgeCheckFound: (stale: number, checked: number, lines: string) =>
    `Veraltete Verweise in ${stale} von ${checked} Einträgen:\n${lines}\nKorrigiere echte Funde mit knowledge_save. Stimmt ein Verweis doch (liegt z. B. außerhalb des Repos oder ist ein Beispiel), markiere den Eintrag mit knowledge_mark_checked.`,
  knowledgeCheckNoGit: "Ohne Git geprüft: Bezeichner gelten erst als fehlend, wenn eine frühere Prüfung sie gefunden hat.",
  // knowledge_mark_checked
  knowledgeMarkDescription:
    "Markiert die fehlenden Verweise eines Eintrags als Fehlalarm: die Prüfung lässt sie danach aus, das Datum des Eintrags bleibt. Nur für Verweise, die stimmen; echte Funde vorher mit knowledge_save korrigieren, sonst werden sie mit markiert.",
  knowledgeMarkId: "Kennung des Eintrags",
  knowledgeMarked: (id: string, refs: string) => `Als geprüft markiert: ${id} (${refs}).`,
  knowledgeMarkNothing: (id: string) => `Nichts zu markieren: ${id} hat keine fehlenden Verweise.`,
  // dev tools
  devEnvironmentDescription:
    "Stand von Dev-Server und Test-Datenbank des Projekts: Status, Adresse, Verbindungs-URL der lokalen PostgreSQL-Testdatenbank, Namen der Test-Umgebungsvariablen und die letzten Zeilen der Dev-Server-Ausgabe. In einem Agenten-Worktree auch, was FORGE dort vorbereitet hat (Abhängigkeiten, lokale Konfiguration, Build-Ausgaben, eigene Datenbank) und was davon noch läuft oder fehlgeschlagen ist.",
  devEnvironmentWait: "true: in einem Agenten-Worktree erst warten, bis die Vorbereitung fertig ist (höchstens 4 Minuten)",
  devControlDescription:
    "Startet, stoppt oder startet Dev-Server bzw. Test-Datenbank neu. reset (nur Datenbank) löscht alle Daten der Test-Datenbank. Der Dev-Server bekommt die Test-Umgebung und, solange sie läuft, die URL der Test-Datenbank.",
  // project context
  knowledgeIntro: "Projektwissen (FORGE): Gesammeltes Wissen zu diesem Projekt liegt in .forge/knowledge (Markdown, im Git).",
  knowledgeInWorktree: (dir: string) =>
    `Du arbeitest in einem Worktree. Das Projektwissen liegt im Ordner des Hauptprojekts: ${dir}. Eine Kopie in deinem Worktree ist nicht maßgeblich.`,
  knowledgeIndex: (total: number, shown: number, summaries: boolean, lines: string) =>
    `Index beim Start dieser Session (${total} Einträge${total > shown ? `, die ${shown} neuesten` : ""}, ${summaries ? "Kennung: Titel. Zusammenfassung [Tags]" : "Kennung: Titel [Tags]; Zusammenfassungen liefert knowledge_search"}; Neueres findet knowledge_search):\n${lines}`,
  knowledgeEmpty: "Beim Start dieser Session gab es noch keine Einträge. Lege die ersten an, sobald du etwas Passendes herausfindest.",
  knowledgeRead:
    "- Bevor du in einem Bereich arbeitest, zu dem es einen passenden Eintrag gibt, lies ihn mit mcp__forge__knowledge_read. Bei Fragen zu Abläufen, Entscheidungen oder Stolperfallen suche zuerst mit knowledge_search.",
  knowledgeSave:
    "- Speichere mit knowledge_save, was künftigen Sessions Zeit spart und nicht offensichtlich im Code oder in CLAUDE.md steht: Entscheidungen mit Begründung, Stolperfallen und ihre Lösung, Abläufe (Setup, Tests, Deploy), Eigenheiten externer Dienste. Speichere, sobald du so etwas herausgefunden hast, nicht erst am Ende. Kleine Aufgaben (Commit, Push, kurze Frage, kleiner Fix ohne neue Erkenntnis) brauchen keinen Eintrag: Speichern kostet den Nutzer 15 bis 35 Sekunden Wartezeit.",
  knowledgeRules:
    "- Keine Geheimnisse (Passwörter, Tokens, Keys), kein Sitzungsprotokoll, nichts Kurzlebiges. Ein Thema pro Eintrag; bestehende Einträge aktualisieren statt neue anzulegen, Veraltetes korrigieren oder mit knowledge_delete löschen. Titel und Tags sind das, was andere Sessions im Index sehen: Titel mit Suchbegriffen, vorhandene Tags wiederverwenden.",
  knowledgeOverlaps: (pairs: string) =>
    `- Aufräumen: Diese Einträge überschneiden sich wahrscheinlich: ${pairs}. Arbeitest du ohnehin in dem Bereich, lies sie und führe sie mit knowledge_merge zusammen, wenn es dasselbe Thema ist.`,
  knowledgeLong: (list: string) => `- Sehr lange Einträge: ${list}. Aktualisierst du einen davon, kürze ihn auf das, was nicht im Code steht.`,
  knowledgeOnlyTools: "- Ändere das Projektwissen nur mit den knowledge_*-Werkzeugen, nicht mit Read, Edit oder Write auf die Dateien.",
  devIntro:
    "Dev-Umgebung (FORGE): mcp__forge__dev_environment zeigt Dev-Server (Adresse, letzte Ausgabe) und die lokale PostgreSQL-Testdatenbank (Verbindungs-URL). Nutze für Tests, Migrationen und Experimente mit Daten diese Testdatenbank, nie eine Produktionsdatenbank. dev_control startet, stoppt oder leert sie und startet den Dev-Server neu.",
  previewIntro:
    "Vorschau (FORGE): preview_screenshot zeigt dir die laufende Web-App als Bild (Standard: Adresse des Dev-Servers, path für Unterseiten), preview_console liefert Konsolenmeldungen, Ausnahmen und fehlgeschlagene Anfragen, preview_interact klickt, tippt und wartet auf der Seite. Nur Adressen auf diesem Rechner. Prüfe UI-Änderungen damit selbst, bevor du sie als fertig meldest.",
  // preview tools
  previewUrl: "Lokale Adresse, z. B. http://localhost:5173/login. Weglassen: Adresse des laufenden Dev-Servers",
  previewPath: "Pfad relativ zur Adresse, z. B. /settings",
  previewWidth: "Breite des Fensters in Pixeln (Standard 1280)",
  previewHeight: "Höhe des Fensters in Pixeln (Standard 800)",
  previewScreenshotDescription:
    "Lädt die laufende Web-App des Projekts in einem unsichtbaren Browser und liefert einen Screenshot als Bild, dazu Titel, Adresse, HTTP-Status und eine Zählung der Konsolenmeldungen. Nur Adressen auf diesem Rechner (localhost, 127.0.0.1, ::1).",
  previewFullPage: "true: ganze Seite statt nur des sichtbaren Bereichs",
  previewConsoleDescription:
    "Konsolenmeldungen (error, warn, log), unbehandelte Ausnahmen und fehlgeschlagene Netzwerk-Anfragen (Status ab 400 oder abgebrochen) der Web-App. Ohne url und path die zuletzt geöffnete Seite, sonst wird sie geladen.",
  previewReload: "true: Seite neu laden statt die bisherigen Meldungen zu lesen",
  previewInteractDescription:
    "Führt Schritte auf der Seite aus (ohne url und path auf der zuletzt geöffneten): click (CSS-Selektor), type (Selektor und Text; clear ersetzt den Inhalt), press (Taste wie Enter, Tab, Escape, ArrowDown, Control+a), wait (ms oder Selektor). Bricht beim ersten Fehler ab und liefert danach einen Screenshot.",
  previewSelector:
    'CSS-Selektor (click, type, wait); außerdem text=Anmelden, button:has-text("Speichern"), xpath=//button und ein angehängtes >> nth=1',
  previewText: "Text für type",
  previewClear: "type: vorhandenen Inhalt ersetzen",
  previewKey: "Taste für press",
  previewMs: "wait: Wartezeit, mit selector das Zeitlimit",
  previewStepTimeout: "Zeitlimit je Schritt für das Finden eines Elements (Standard 5000)",
  previewNoScreenshot: "false: ohne Screenshot am Ende",
  // agent status words
  status: {
    starting: "startet",
    running: "arbeitet",
    waiting_approval: "wartet auf eine Freigabe des Nutzers",
    stopping: "stoppt",
    idle: "fertig, wartet auf Anweisungen",
    stopped: "beendet",
    interrupted: "unterbrochen",
    error: "mit Fehler beendet",
  } as Record<string, string>,
  projectToolsUnavailable: (error: string) => `Projektwissen und Dev-Werkzeuge nicht verfügbar: ${error}`,
  // notify
  notifyDescription:
    "Benachrichtigt den Nutzer in FORGE (Hinweis mit Ton). urgent=true nur, wenn er wirklich sofort gebraucht wird: dann ruft FORGE ihn an, sofern das Telefon eingerichtet ist.",
  notifyMessage: "Kurze Nachricht an den Nutzer, ein bis zwei Sätze",
  notifyUrgent: "true: dringend, darf anrufen",
  notifiedUrgent: "Der Nutzer wurde dringend benachrichtigt.",
  notified: "Der Nutzer wurde benachrichtigt.",
  // usage_status, daily_report
  usageStatusDescription:
    "Nutzung des Claude-Abos des Nutzers: 5-Stunden- und Wochenfenster in Prozent mit Reset-Zeit, die Prognose nach dem bisherigen Tempo (Limit vor dem Reset erreicht oder reicht bis zum Reset) und ob ein Limit erreicht ist. Vor großem Aufwand prüfen (mehrere Agenten, lange Läufe), damit die Arbeit nicht am Limit abbricht.",
  dailyReportDescription:
    "Tagesbericht von FORGE: Sessions mit Durchläufen, parallele Agenten (gestartet, zusammengeführt, verworfen, wartend), Commits (Auto-Commits markiert), was gerade offen ist (Rückfragen, Freigaben, Fehler, geplantes Weitermachen nach dem Nutzungslimit), bei allen Projekten auch Telefonate. Für Fragen wie „Was ist heute passiert?“ oder „Was haben die Agenten gestern geschafft?“.",
  dailyReportDate: "Tag im Format JJJJ-MM-TT; weglassen für heute",
  dailyReportAllProjects: "true: alle Projekte; sonst nur dieses Projekt mit seinen Agenten",
  usageLine: "- usage_status: Abo-Nutzung und Limits; vor großem Aufwand (mehrere Agenten, lange Läufe) prüfen.",
  dailyReportLine: "- daily_report: was an einem Tag passiert ist (Sessions, Agenten, Commits, Offenes); für Rückblicke und „Was ist heute passiert?“.",
  // session context
  introNoGit: "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code. Neben deinen Werkzeugen gibt es FORGE-Werkzeuge (mcp__forge__…).",
  noGit: (cwd: string) =>
    `Dieses Projekt arbeitet bewusst ohne Git: Der Nutzer hat Git für ${cwd} in FORGE ausgeschaltet. Führe keine git-Befehle aus (kein git init, status, add, commit, branch, checkout, push), lege kein Repository an und schlage keine Commits, Branches oder Pull Requests vor. Auch ein vorhandener .git-Ordner bleibt unberührt. Änderungen landen nur als Dateien im Ordner; wenn etwas rückgängig gemacht werden muss, geht das nur über die Dateien selbst.`,
  noGitAgents: "Parallele Agenten (start_agent) gibt es deshalb hier nicht.",
  notifyLine: "- notify: den Nutzer aktiv benachrichtigen. urgent=true nur, wenn er sofort gebraucht wird (kann sein Telefon klingeln lassen).",
  autoMergeLine:
    "In diesem Projekt führt FORGE deinen Branch automatisch zusammen, sobald ein Durchlauf ohne Fehler endet. Rückfragen deshalb nur mit AskUserQuestion stellen, nie als Frage am Ende deiner Antwort. Beende einen Durchlauf erst, wenn die Arbeit fertig ist.",
  autoCommitLine: (autoPush: boolean) =>
    `In diesem Projekt committet FORGE nach jedem erfolgreichen Durchlauf selbst die darin geänderten Dateien (Tag auto-commit${autoPush ? ", danach Push außer auf main/master (auto-push)" : ""}). Mit deiner nächsten Nachricht nennt dir FORGE diese Commits. Soll committet oder gepusht werden, ist das meist schon passiert: prüfe mit git status und git log, committe nur, was noch offen ist, und push dann.`,
  testLine: (testCommand: string | null) =>
    `Tests gezielt ausführen: nur die zu deinen Änderungen passenden (einzelne Testdateien, betroffene Pakete), nicht nach jeder Kleinigkeit die ganze Suite, nicht erneut ohne Änderung seit dem letzten grünen Lauf.${
      testCommand
        ? ` FORGE führt nach jedem Durchlauf selbst „${testCommand}“ aus, wenn sich dafür relevante Dateien geändert haben (Tag auto-test), und nennt dir Fehlschläge mit deiner nächsten Nachricht. Die ganze Suite musst du deshalb nicht selbst starten.`
        : ""
    }`,
  introAgent: "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code, als paralleler Agent: Eine andere FORGE-Session hat dich gestartet.",
  agentWorktree: (cwd: string) => `Du arbeitest im Git-Worktree ${cwd} auf einem eigenen Branch. Ändere nur Dateien in diesem Ordner.`,
  agentFinish:
    "Wenn du fertig bist: committe deine Arbeit auf deinem Branch und fasse am Ende in wenigen Sätzen zusammen, was du gemacht hast und was offen ist. Die startende Session liest diese Zusammenfassung.",
  agentNotify: "Mit mcp__forge__notify kannst du den Nutzer benachrichtigen. Weitere Agenten kannst du nicht starten.",
  // agent lookup errors
  agentNotFound: (ref: string, known: string) => `Keinen Agenten „${ref}“ gefunden. Vorhanden: ${known}.`,
  noOwnAgents: "Diese Session hat keine Agenten gestartet.",
  agentNoWorktree: (id: string) => `Agent ${id} hat keinen Worktree mehr, er ist schon abgeschlossen.`,
  noAgentsInProject: "In diesem Projekt gibt es keine Agenten.",
  // start_agent
  startAgentDescription:
    "Startet einen parallelen Agenten (eigene Claude-Code-Session) in einem neuen Git-Worktree auf eigenem Branch. Für unabhängige Teilaufgaben, die gleichzeitig laufen können. Der Agent sieht diesen Chat nicht: Der Auftrag muss für sich allein verständlich sein. Sein Branch beginnt beim letzten Commit deines aktuellen Branches. Nicht committete Änderungen sieht er nur mit with_changes=true: Dann beginnt sein Branch mit einem Commit dieses Stands (ohne .env, Schlüssel und Build-Ausgaben); dein Ordner bleibt unverändert.",
  agentsOffRefused:
    "In diesem Projekt hat der Nutzer parallele Agenten ausgeschaltet. Es wurde kein Agent gestartet. Erledige die Aufgabe selbst in dieser Session, eine nach der anderen.",
  startAgentTask: "Vollständiger Auftrag mit allem nötigen Kontext",
  startAgentName: "Kurzer Name für den Branch, z. B. csv-export",
  startAgentWithChanges: "true: der Agent bekommt auch den nicht committeten Stand deines Ordners",
  startAgentWithChangesNote: " Er hat deinen nicht committeten Stand als ersten Commit seines Branches.",
  startAgentOpenNote: (open: number) =>
    ` Hinweis: ${open} ${open === 1 ? "Datei ist" : "Dateien sind"} bei dir nicht committet, die sieht er nicht (with_changes=true hätte sie mitgegeben).`,
  startAgentWarning: (warning: string) => ` Hinweis: ${warning}`,
  agentStarted: (id: string, branch: string, dir: string) =>
    `Agent ${id} gestartet, Branch ${branch}, Ordner ${dir}. Er arbeitet unabhängig; den Stand gibt agent_status. Seine Änderungen liegen nur auf seinem Branch.`,
  // agent_status
  agentStatusDescription:
    "Stand der Agenten, die diese Session gestartet hat: Status, Branch und ihre letzte Antwort. Ohne agent auch die übrigen Agenten des Projekts (aus dem Agenten-Reiter, vom Telefon oder aus anderen Sessions).",
  agentStatusAgent: "Kürzel eines Agenten; weglassen für alle",
  otherAgentLine: (branch: string, status: string | null, dir: string, exists: boolean) =>
    `- ${branch}: ${status ?? "ohne Session"}, Ordner ${dir}${exists ? "" : " (fehlt)"}`,
  otherAgentsBlock: (lines: string) => `Weitere Agenten dieses Projekts (finish_agent mit dem Branch):\n${lines}`,
  agentDeleted: (id: string) => `${id}: gelöscht`,
  agentLine: (id: string, title: string | null, status: string, branch: string | null, dir: string) =>
    `${id} (${title ?? "ohne Titel"}): ${status}, Branch ${branch ?? "unbekannt"}, Ordner ${dir}`,
  agentLastAnswer: (text: string) => `  Letzte Antwort: ${text}`,
  // message_agent
  messageAgentDescription: "Schickt einem Agenten dieser Session eine weitere Anweisung; er arbeitet dann weiter.",
  messageAgentAgent: "Kürzel des Agenten",
  messageAgentText: "Anweisung, vollständig ausformuliert",
  messageSent: (id: string) => `An Agent ${id} gesendet.`,
  // finish_agent
  finishAgentDescription:
    "Schließt einen Agenten dieses Projekts ab, auch einen, den diese Session nicht gestartet hat. merge: übernimmt seinen Branch in den Branch, von dem er abgezweigt ist (Rebase, dann Fast-Forward). discard: verwirft seine Arbeit. Danach sind seine Session beendet und Worktree-Ordner, FORGE-Eintrag und Branch gelöscht. Nur nach Rücksprache mit dem Nutzer. Bei Konflikten im Rebase löst der Agent sie selbst; danach erneut merge.",
  finishAgentAgent: "Kürzel eines eigenen Agenten oder Branch eines anderen Agenten des Projekts (wie agent_status sie nennt)",
  // main session context
  intro: "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code. Neben deinen Werkzeugen gibt es FORGE-Werkzeuge (mcp__forge__…):",
  startAgentLine:
    "- start_agent: startet einen parallelen Agenten in einem eigenen Git-Worktree auf eigenem Branch. Nur für Teilaufgaben, die wirklich unabhängig und gleichzeitig laufen können; der Auftrag muss für sich allein verständlich sein. Der Agent startet beim letzten Commit deines Branches; deinen nicht committeten Stand bekommt er nur mit with_changes=true.",
  agentsOffLine:
    "- Parallele Agenten hat der Nutzer in diesem Projekt ausgeschaltet: kein start_agent, auch keine Subagenten mit Worktree-Isolation. Arbeite Aufgaben nacheinander in dieser Session ab, auch unabhängige Teilaufgaben.",
  agentStatusLine: "- agent_status und message_agent: Agenten verfolgen und anleiten. Ihre Arbeit liegt auf ihren Branches.",
  finishAgentLine: (autoMerge: boolean) =>
    `- finish_agent: einen Agenten des Projekts zusammenführen (merge) oder verwerfen (discard), auch einen fremden; danach sind Session, Worktree, FORGE-Eintrag und Branch weg. Nur nach Rücksprache mit dem Nutzer. ${
      autoMerge
        ? "In diesem Projekt führt FORGE fertige Agenten automatisch zusammen (auto-merge), sobald ihr Durchlauf ohne Fehler endet. Was dabei nicht klappt, legt FORGE dem Nutzer vor."
        : "FORGE zeigt dem Nutzer fertige Agenten auch selbst zur Entscheidung an."
    }`,
};
