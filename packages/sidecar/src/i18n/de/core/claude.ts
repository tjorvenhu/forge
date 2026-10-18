/** German texts (core.claude). Source of the keys: the English file is typed against this one. */
export const claude = {
  // attachments.ts
  attachDenied: (p: string) => `Diese Datei darf nicht angehängt werden: ${p}`,
  fileNotFound: (p: string) => `Datei nicht gefunden: ${p}`,
  notAFile: (p: string) => `Keine Datei: ${p}`,
  imageFormatUnsupported: (name: string) => `Bildformat nicht unterstützt: ${name}`,
  binaryNotAllowed: (name: string) => `${name}: Binärdateien können nur als Bild oder PDF angehängt werden.`,
  readImageHint: "Sieh es dir bei Bedarf mit dem Read-Werkzeug an, es verkleinert Bilder dabei.",
  readPdfHint: "Lies sie bei Bedarf mit dem Read-Werkzeug, bei vielen Seiten abschnittsweise mit dem Parameter pages.",
  readFileHint: "Lies sie bei Bedarf mit dem Read-Werkzeug, bei großen Dateien abschnittsweise mit offset und limit.",
  attachedTooLarge: (name: string, size: string, file: string) =>
    `Angehängte Datei: ${name} (${size}), zu groß für die Nachricht selbst. Sie liegt unter ${file}`,
  attachedFile: (name: string) => `Angehängte Datei: ${name}`,
  /** decimal comma or point for the size of an attachment */
  decimalSeparator: ",",
  spillFileName: "nachricht.txt",
  messageSpilled: (omitted: string, total: string, file: string) =>
    `[… ${omitted} Zeichen ausgelassen. Die Nachricht hat ${total} Zeichen und ist zu lang für eine Eingabe. Der vollständige Text steht in ${file}. Lies ihn bei Bedarf mit dem Read-Werkzeug, abschnittsweise mit offset und limit.]`,

  // uploads.ts
  uploadRunning: "Dieser Upload läuft bereits.",
  uploadIncomplete: "Upload unvollständig. Bitte die Datei erneut einfügen.",
  uploadTooLarge: (name: string, mb: number) => `${name} ist größer als ${mb} MB.`,

  // normalize.ts
  truncationMark: "\n[… gekürzt]",

  // diagnostics.ts
  notFound: "nicht gefunden",
  authUnreadable: "Auth-Status nicht lesbar",

  // update.ts
  versionQueryFailed: (status: number) => `Versionsabfrage fehlgeschlagen (HTTP ${status})`,
  versionQueryEmpty: "Versionsabfrage lieferte keine Versionsnummer",

  // setup.ts
  setupBusy: "Es läuft bereits ein Einrichtungsschritt.",
  installed: (where: string) => `Installiert: ${where}`,
  installerNotFound: "Installer beendet, aber Claude Code wurde nicht gefunden.",
  installerExit: (code: number | null) => `Installer beendet mit Code ${code}`,
  notInstalled: "Claude Code ist nicht installiert.",
  updateExit: (code: number | null) => `Update beendet mit Code ${code}`,
  updateDone: (version: string | null) => (version ? `Claude Code ${version} ist installiert.` : "Update abgeschlossen."),
  loggedIn: "Angemeldet",
  loginExit: (code: number | null) => `Anmeldung beendet mit Code ${code}`,
  logoutFailed: (why: string) => `Abmelden fehlgeschlagen${why ? `: ${why}` : "."}`,
  noLogin: "Keine laufende Anmeldung.",

  // runtime.ts
  remoteUnavailable: "Remote Control ist mit dieser Claude-Code-Version nicht verfügbar.",
  usageUnavailable: "Die Plan-Auslastung ist mit dieser Claude-Code-Version nicht verfügbar.",
  oneShotTimeout: (what: string, seconds: number) => `${what}: Claude Code hat nicht innerhalb von ${seconds} Sekunden geantwortet.`,
  oneShotCommands: "Slash-Commands laden",
  oneShotAnswer: "Antwort von Claude",
  oneShotUsage: "Plan-Auslastung",
  noAnswer: (subtype: string) => `Claude konnte keine Antwort erzeugen (${subtype})`,
  noStructuredAnswer: "Claude hat keine strukturierte Antwort geliefert.",
  approvalFailed: "Die Freigabeanfrage konnte nicht verarbeitet werden.",
  policyCheckFailed: "Die Policy-Prüfung ist fehlgeschlagen, der Aufruf wurde vorsichtshalber abgelehnt.",
  policyDenied: (rule: string, message: string) => `FORGE-Policy (${rule}): ${message}`,
  noTaskOutput: "Diese Claude-Code-Version liefert keine Ausgabe von Hintergrundaufgaben.",
  toolError: (message: string) => `Fehler: ${message}`,
  capabilities: {
    sessionStart: { label: "Session starten", note: "Agent SDK query() mit Streaming-Input" },
    sessionSend: { label: "Prompt senden", note: "Weitere Nachrichten in derselben Session" },
    streamTokens: { label: "Token-Streaming", note: "includePartialMessages" },
    streamTools: { label: "Tool-Events", note: "tool_use / tool_result" },
    approvals: { label: "Freigabeanfragen", note: "canUseTool-Callback" },
    interrupt: "Stop/Cancel",
    interruptReceipt: "interrupt() mit Bestätigung",
    resume: { label: "Resume", note: "options.resume, auch Terminal-Sessions" },
    sessionsList: { label: "Sessions auflisten", note: "listSessions({ dir })" },
    modelSwitch: { label: "Modell wechseln", note: "setModel()" },
    permissionModes: { label: "Permission-Modi", note: "default, acceptEdits, plan, bypassPermissions" },
    policyHook: { label: "Harte Sperrliste", note: "PreToolUse-Hook, greift auch im Bypass" },
    slashCommands: "Slash-Commands",
    slashReported: (n: number) => `${n} Commands/Skills gemeldet; interaktive Built-ins nicht verfügbar`,
    slashUnknown: "Liste erst nach Sessionstart bekannt",
    attachments: { label: "Bilder/Dateien im Prompt", note: "Bilder, PDFs und Textdateien als Content-Blöcke" },
    rewind: { label: "Dateien zurücksetzen", note: "enableFileCheckpointing + rewindFiles()" },
    fork: { label: "Verzweigen", note: "forkSession() bis vor eine Nachricht" },
    questions: { label: "Rückfragen und Plan-Freigabe", note: "AskUserQuestion-Antworten und ExitPlanMode über canUseTool" },
    context: { label: "Kontextauslastung", note: "getContextUsage() nach jedem Durchlauf, /compact" },
    remote: { label: "Remote Control (Claude-App)", note: "Bridge der laufenden Session; im SDK nicht dokumentiert" },
    usage: { label: "Token-Usage", note: "aus result.usage" },
    cost: { label: "Kosten", note: "Bei Abo nur API-Äquivalent, wird nicht angezeigt" },
    terminal: { label: "Eingebettetes Terminal", note: "xterm.js + PTY in der Tauri-Hülle" },
  },

  // usage.ts
  windowFiveHours: "5 Stunden",
  windowWeek: "Woche",
  windowWeekModel: (model: string) => `Woche ${model}`,
  limitReached: (until: string | null) => `Limit erreicht${until ? `, wieder frei ${until}` : ""}. Neue Durchläufe scheitern bis dahin.`,
  limitWarning: (percent: number | null, reset: string | null) =>
    `Limit fast erreicht${percent !== null ? ` (${percent} %)` : ""}${reset ? `, Reset ${reset}` : ""}.`,
  usageUnavailableLine: (error: string | null) => `Nutzung nicht verfügbar${error ? `: ${error}` : ""}.`,
  windowLine: (label: string, percent: number, reset: string | null, outlook: string | null) =>
    `${label}: ${percent} % genutzt${reset ? `, Reset ${reset}` : ""}${outlook ? `. Prognose: ${outlook}` : ""}`,
  noForecast: "Prognose: noch zu wenig Messwerte oder kein Anstieg.",
  subscription: (type: string) => `Abo: ${type}`,
  today: (time: string) => `heute ${time}`,
  forecastLimit: (at: string) => `bei diesem Tempo ist das Limit gegen ${at} erreicht, vor dem Reset`,
  forecastEnough: "reicht bis zum Reset",
  limitWarningPart: (label: string, at: string, reset: string | null) => `${label} gegen ${at}${reset ? ` (Reset ${reset})` : ""}`,
  limitWarningText: (parts: string) => `Bei diesem Tempo ist das Nutzungslimit vor dem Reset erreicht: ${parts}. Weitere Agenten verbrauchen es schneller.`,
};
