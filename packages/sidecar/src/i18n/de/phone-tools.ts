/** German descriptions of the phone tools for the model (Claude or Gemini Live). Keys: tool name, then parameter (array items as "param.item"). */
export const phoneTools = {
  status: {
    description: "Überblick: laufende und kürzlich beendete Sessions mit Kürzel, Status, offene Freigaben und Rückfragen, Remote Control.",
  },
  details: {
    description: "Letztes Ergebnis einer Session, offene Rückfrage oder Plan im Wortlaut, laufende Hintergrund-Aufgaben und Subagenten.",
    params: {
      summary: "true, wenn er eine Zusammenfassung des ganzen Verlaufs will (dauert ein paar Sekunden)",
    },
  },
  send_message: {
    description: "Schickt einer Session eine Anweisung; Claude Code arbeitet dann weiter. Eine geschlossene Session wird dafür wieder geöffnet.",
    params: {
      text: "Anweisung an Claude Code, vollständig ausformuliert",
    },
  },
  start_session: {
    description: "Startet eine neue Claude-Code-Session in einem Projekt, auf Wunsch als parallelen Agenten in einem eigenen Worktree.",
    params: {
      prompt: "Auftrag, vollständig ausformuliert",
      model: "nur wenn der Anrufer ein Modell nennt: opus, sonnet oder haiku",
      effort: "Denkaufwand, nur wenn der Anrufer ihn nennt",
      plan_only: "true, wenn Claude erst einen Plan machen soll",
      agent: "true, wenn die Aufgabe parallel als eigener Agent laufen soll (eigener Worktree und Branch ab dem letzten Commit des genannten Projekts oder Worktrees); nicht in Projekten, in denen parallele Agenten ausgeschaltet sind",
      with_changes: "nur mit agent: true, wenn der Agent auch den noch nicht committeten Stand des Projekts bekommen soll",
    },
  },
  respond: {
    description: "Beantwortet die offene Freigabe, Rückfrage oder den Plan einer Session. allow = erlauben, Plan annehmen oder Rückfrage beantworten (answers). deny = ablehnen oder Plan mit feedback zurückgeben.",
    params: {
      answers: "nur für Rückfragen: je Frage die gewählte Antwort",
      "answers.question": "Fragetext",
      "answers.answer": "gewählte Antwort",
      feedback: "bei deny: Begründung oder Änderungswunsch",
      for_session: "nur bei allow einer Werkzeug-Freigabe: true erlaubt dieses Werkzeug für den Rest der Session ohne weitere Nachfrage",
    },
  },
  stop_session: {
    description: "Stoppt den laufenden Durchlauf einer Session; sie bleibt offen. Läuft gerade nichts, sagt es das.",
  },
  close_session: {
    description: "Schließt eine Session (beendet ihren Claude-Prozess). Sie bleibt mit Verlauf erhalten und lässt sich mit send_message wieder fortsetzen.",
  },
  session_settings: {
    description: "Ändert Modell, Denkaufwand oder Modus einer Session. Nur angeben, was sich ändern soll.",
    params: {
      model: "opus, sonnet, haiku oder eine Modell-ID",
      effort: "Denkaufwand",
      permission_mode: "default = fragt nach, acceptEdits = Änderungen ohne Nachfrage, plan = nur planen, bypassPermissions = alles ohne Nachfrage",
    },
  },
  cancel_auto_continue: {
    description: "Bricht das geplante automatische Weitermachen einer Session nach einem Nutzungslimit ab.",
  },
  background_task: {
    description: "Hintergrund-Aufgaben und Subagenten einer Session, wie details sie auflistet. output: was ein Hintergrund-Befehl zuletzt ausgegeben hat. stop: eine Aufgabe oder einen Subagenten beenden, der Rest läuft weiter. to_background: laufende Arbeit aus dem Vordergrund in den Hintergrund schieben, damit Claude weitermachen kann (ohne task: alles). message: dem Anrufer eine Nachricht (text) an die Aufgabe schreiben lassen; ein Subagent bekommt sie über Claude, zu einem Befehl liest Claude sie und reagiert selbst.",
    params: {
      task: "Beschreibung der Aufgabe oder ein Teil davon, wie details sie nennt",
      text: "nur bei message: die Nachricht im Wortlaut des Anrufers",
    },
  },
  remote_control: {
    description: "Remote Control: verbindet alle laufenden Sessions mit der Claude-App (on), trennt sie (off) oder sagt den Stand (status).",
  },
  always_on_top: {
    description: "Hält das FORGE-Hauptfenster am Computer über allen anderen Programmen (on), gibt es wieder frei (off) oder sagt den Stand (status). Ausgekoppelte Chat-Fenster werden am Rechner einzeln angeheftet.",
  },
  chat_window: {
    description: "Chat-Fenster am Computer: sagt, welche Sessions in einem eigenen Fenster offen und welche davon angeheftet sind (status), öffnet eine Session in einem eigenen Fenster (open), holt sie ins Hauptfenster zurück (close), hält ihr Fenster über allen anderen Programmen (pin, öffnet es dafür bei Bedarf) oder gibt es wieder frei (unpin).",
    params: {
      session: "Kürzel wie S1 oder ein Teil des Titels; bei status nicht nötig",
    },
  },
  dev_server: {
    description: "Dev-Server eines Projekts oder einer Session: starten, stoppen, neu starten, sagen, ob er läuft und unter welcher Adresse (status), oder seine letzte Ausgabe lesen (output), etwa um zu sehen, warum er abgestürzt ist. Bei Agenten (jeder hat einen eigenen Dev-Server mit eigenem Port): setup sagt, wie weit FORGE seinen Worktree vorbereitet hat (Abhängigkeiten, Konfiguration, Build-Ausgaben, eigene Test-Datenbank), prepare startet diese Vorbereitung neu, etwa nach einer fehlgeschlagenen Installation.",
  },
  test_database: {
    description: "Lokale PostgreSQL-Testdatenbank eines Projekts oder einer Session: starten, stoppen, neu starten, zurücksetzen (löscht alle Daten, nur wenn der Anrufer das ausdrücklich will), sagen, ob sie läuft (status), oder ihr Protokoll lesen (log), etwa wenn sie nicht startet.",
  },
  dev_settings: {
    description: "Einstellungen der Dev-Werkzeuge eines Projekts: ob die Test-Umgebung an Dev-Server und Tests geht (use_env), ihre Variablen (env_set, env_remove, env_from_file), ob die Test-Datenbank mit dem Dev-Server startet (with_dev_server), Port und Name der Test-Datenbank und die Variable mit ihrer Verbindungs-URL (env_var, leer = keine). Nur angeben, was sich ändern soll; ohne Angaben sagt es den Stand. Werte der Variablen werden nie vorgelesen, nur ihre Namen.",
    params: {
      use_env: "Test-Umgebung an Dev-Server und Testbefehl übergeben",
      env_set: "eine Variable der Test-Umgebung setzen, als NAME=Wert",
      env_remove: "Name einer Variable, die aus der Test-Umgebung entfernt wird",
      env_from_file: "Variablen aus dieser .env-Datei im Projektordner übernehmen, z. B. .env.local",
      with_dev_server: "Test-Datenbank startet mit dem Dev-Server",
      port: "Port der Test-Datenbank",
      name: "Name der Datenbank: Kleinbuchstaben, Ziffern, Unterstriche",
      env_var: "Variable für die Verbindungs-URL, z. B. DATABASE_URL; leer übergibt keine",
    },
  },
  project_automation: {
    description: "Automatik eines Projekts, wie in den Projekt-Einstellungen: plan-first (neue Sessions planen erst), auto-test (Testbefehl nach einem Durchlauf, der Code geändert hat), auto-commit, auto-push, auto-merge (fertige Agenten automatisch in den Branch zurückführen, von dem sie gestartet sind), review-required (kein Auto-Commit), no-network (keine Web-Werkzeuge), sandbox-only (Autonomous gesperrt). Mit tag und on schalten; ohne tag sagt es, was an ist. auto-merge gilt immer für das Hauptprojekt samt seinen Agenten.",
    params: {
      tag: "Welche Automatik; weglassen für den Stand",
      on: "true einschalten, false ausschalten",
    },
  },
  knowledge: {
    description: "Projektwissen: gesammelte Entscheidungen, Abläufe und Stolperfallen eines Projekts. Mit query suchen, mit id einen Eintrag vollständig lesen, mit id und delete = true einen veralteten Eintrag löschen. Mit cleanup = true nennen, welche Einträge sich überschneiden oder sehr lang sind; mit merge Einträge zum selben Thema von Claude zusammenführen lassen; mit auto_merge = true sucht Claude selbst, was zusammengehört, und führt alles zusammen. Mit stale = true nennen, welche Einträge auf Dateien oder Bezeichner verweisen, die es nicht mehr gibt (veraltetes Wissen); mit id und mark_checked = true einen solchen Fehlalarm als geprüft markieren; mit id und fix = true korrigiert Claude den Eintrag. Für Fragen wie „Wie deployen wir X?“ oder „Was war bei der Datenbank zu beachten?“.",
    params: {
      query: "Suchwörter, z. B. deploy oder migration; leer bei cleanup und merge",
      id: "Kennung eines Treffers, um ihn vollständig zu lesen oder zu löschen",
      delete: "true löscht den Eintrag mit id; nur wenn der Anrufer das ausdrücklich will",
      cleanup: "true nennt Einträge, die sich überschneiden, und sehr lange Einträge",
      merge: "Kennungen mit Komma getrennt, z. B. aus cleanup; der erste Eintrag bleibt, die anderen gehen in ihm auf. Nur wenn der Anrufer das will",
      auto_merge: "true: Claude sucht selbst Einträge zum selben Thema und führt sie zusammen (dauert ein bis zwei Minuten). Nur wenn der Anrufer das will",
      stale: "true nennt Einträge mit Verweisen auf Dateien oder Bezeichner, die es nicht mehr gibt, etwa bei „Welches Wissen ist veraltet?“",
      mark_checked: "true mit id: die fehlenden Verweise des Eintrags waren ein Fehlalarm und werden nicht mehr gemeldet",
      fix: "true mit id: Claude korrigiert die veralteten Verweise des Eintrags und speichert ihn (dauert bis zu einer Minute). Nur wenn der Anrufer das will",
    },
  },
  remember: {
    description: "Legt eine Notiz im Projektwissen ab, wenn der Anrufer sagt, dass FORGE oder Claude sich etwas für ein Projekt merken soll. Gibt es schon einen Eintrag zum Thema, wird die Notiz dort ergänzt.",
    params: {
      title: "Kurzes Thema, z. B. Deploy oder Kundenwunsch Checkout",
      text: "Die Notiz, vollständig ausformuliert, wie der Anrufer sie gemeint hat",
    },
  },
  git: {
    description: "Git in einem Projekt oder einer Session (bei Agenten ihr Worktree). status: Branch und Änderungen. log: die letzten Commits. show: was ein Commit geändert hat (commit), mit path der Diff einer Datei daraus. diff: was sich in einer Datei geändert hat (path). commit: alle Änderungen committen (ohne message schreibt FORGE die Nachricht). push: aktuellen Branch pushen, neue Commits vom Server werden vorher übernommen. pull: neue Commits vom Server holen, eigene Commits kommen per Rebase obendrauf. fetch: nur nachsehen, was es auf dem Server Neues gibt. branches: lokale Branches. checkout: auf branch wechseln. delete_branch: lokalen branch löschen. restore: Dateien auf den Stand eines Commits zurücksetzen, als nicht committete Änderungen; offene Arbeit wird vorher beiseitegelegt. init: Git-Repository anlegen. publish: Projekt als neues Repository auf GitHub veröffentlichen, auf Wunsch in einer Organisation (owner). account: mit welchem GitHub-Konto FORGE angemeldet ist und in welchen Organisationen es Repositorys anlegen kann. identity: Name und E-Mail für Commits sagen oder mit name und email setzen. unpushed: welche Projekte (ohne project) Änderungen oder Commits haben, die noch nicht auf GitHub sind. push_all: in allen diesen Projekten offene Änderungen committen und pushen, damit der ganze Stand auf GitHub liegt und es an einem anderen Rechner weitergehen kann; main und master nur mit allow_protected. Lassen sich die Stände nicht automatisch zusammenführen, startet FORGE eine Session, in der Claude das erledigt.",
    params: {
      message: "Commit-Nachricht, nur wenn der Anrufer eine vorgibt",
      allow_protected: "Push auf main oder master; nur wenn der Anrufer das ausdrücklich will",
      branch: "bei checkout und delete_branch: Name des Branches",
      create: "nur bei checkout: true legt den Branch neu an",
      force: "nur bei delete_branch: true löscht auch einen Branch mit Commits, die sonst nirgends sind; nur wenn der Anrufer das ausdrücklich will",
      commit: "bei restore und show: Hash, Position im Log (1 = neuester Commit) oder Worte aus der Commit-Nachricht",
      path: "bei diff und show: Dateiname oder Teil davon",
      private: "nur bei publish: false veröffentlicht öffentlich, sonst privat",
      owner: "nur bei publish: GitHub-Organisation, in der das Repository entsteht; ohne: persönliches Konto",
      name: "bei publish: Name des Repositorys; bei identity: Name für Commits",
      email: "nur bei identity: E-Mail für Commits",
    },
  },
  pull_request: {
    description: "Pull Request auf GitHub für den aktuellen Branch eines Projekts oder einer Session, etwa eines Agenten. create: Branch pushen und PR anlegen; Titel und Beschreibung schreibt FORGE aus den Commits. status: Zustand des PR mit CI-Checks und Review.",
    params: {
      draft: "nur bei create: true legt einen Entwurf an",
    },
  },
  remove_agent: {
    description: "Räumt einen Agenten auf: beendet seine Session und entfernt seinen Worktree. Der Branch mit seinen Commits bleibt, außer delete_branch = true. Nicht committete Änderungen verhindern das Entfernen, außer force = true.",
    params: {
      session: "Kürzel der Agent-Session wie S2",
      project: "oder der Name des Agent-Worktrees, z. B. shop csv-export",
      delete_branch: "true löscht auch den Branch des Agenten; nur wenn der Anrufer das ausdrücklich will",
      force: "true entfernt trotz nicht committeter Änderungen; nur wenn der Anrufer das ausdrücklich will",
    },
  },
  finish_agent: {
    description: "Schließt einen fertigen Agenten ab. review: sagt vorher, was er getan hat (Commits, Dateien, nicht Committetes, seine Zusammenfassung) und ob Zusammenführen gerade geht. merge: übernimmt seine Arbeit in den Branch, von dem er abgezweigt ist, danach sind Worktree und Branch weg. discard: verwirft seine Arbeit, Worktree und Branch werden gelöscht. Hat der Rebase Konflikte, löst der Agent sie und es geht danach mit merge weiter.",
    params: {
      session: "Kürzel der Agent-Session wie S2",
      project: "oder der Name des Agent-Worktrees, z. B. shop csv-export",
      action: "review: prüfen; merge: zusammenführen; discard: verwerfen, nur wenn der Anrufer das ausdrücklich will",
    },
  },
  projects: {
    description: "Liste der Projekte mit Gruppe, Git-Branch und ob ein Dev-Server läuft.",
  },
  project: {
    description: "Projekte verwalten. info: Profil, Standardmodell, Denkaufwand, Test- und Dev-Befehl, Favorit, ob mit Git und ob parallele Agenten erlaubt sind. create: neues Projekt name anlegen (in path oder im Projektordner aus den Einstellungen), auf Wunsch gleich mit GitHub-Repository (auch in einer Organisation) oder ganz ohne Git. import: vorhandenen Ordner path aufnehmen, mit oder ohne Git, auf Wunsch gleich mit GitHub-Repository. clone: Repository url klonen, auch per Name eines GitHub-Repositorys des Kontos. remove: Projekt aus FORGE entfernen; Ordner und GitHub-Repository nur mit delete_folder oder delete_github_repo. rename: neuer name. favorite: als Favorit markieren oder nicht. group: Projekt in die Gruppe group einordnen (z. B. nach Kunde), ohne group aus seiner Gruppe nehmen. rename_group: Gruppe group in name umbenennen, für alle ihre Projekte. dissolve_group: Gruppe group auflösen, die Projekte bleiben. settings: Profil, Standardmodell, Denkaufwand, Test- und Dev-Befehl setzen, Git ein- oder ausschalten und parallele Agenten erlauben oder ausschalten; nur angeben, was sich ändern soll.",
    params: {
      project: "Projektname oder Teil davon; nicht bei create, import und clone",
      name: "create: Name des neuen Projekts; rename: neuer Name; rename_group: neuer Name der Gruppe; clone: Ordnername",
      path: "import: der Ordner; create und clone: Ordner, in dem das Projekt angelegt wird, nur wenn der Anrufer einen nennt",
      url: "clone: Git-URL oder Name eines GitHub-Repositorys",
      git: "create und import: false richtet das Projekt ganz ohne Git ein (keine Git-Bereiche, keine Agenten, Claude nutzt kein Git), ein Ordner mit .git wird aber immer mit Git aufgenommen; settings: true schaltet Git ein, false aus",
      agents:
        "settings: false schaltet parallele Agenten für das Projekt aus, true erlaubt sie wieder. Vor dem Ausschalten dem Anrufer sagen, dass Claude dann weniger effizient arbeitet: Aufgaben laufen nacheinander statt gleichzeitig",
      github: "create und import: auch ein GitHub-Repository anlegen, privat oder öffentlich",
      owner: "create und import mit github: GitHub-Organisation, in der das Repository entsteht; ohne: persönliches Konto",
      delete_folder: "remove: true löscht auch den Ordner; nur wenn der Anrufer das ausdrücklich will, er muss es danach über die Tastatur bestätigen",
      delete_github_repo: "remove: true löscht das ganze GitHub-Repository; nur wenn der Anrufer ausdrücklich das Repository löschen will, nie für Branches. Er muss es danach über die Tastatur bestätigen",
      favorite: "favorite: true markiert, false nimmt die Markierung weg",
      group: "group: Name der Gruppe, z. B. ein Kunde; leer nimmt das Projekt aus seiner Gruppe. rename_group und dissolve_group: die bestehende Gruppe",
      profile: "settings: safe fragt viel nach, balanced ist der Standard, autonomous arbeitet ohne Nachfrage",
      default_model: "settings: opus, sonnet, haiku oder eine Modell-ID; default nimmt die globale Einstellung",
      default_effort: "settings: Denkaufwand neuer Sessions; default nimmt die globale Einstellung",
      test_command: "settings: Testbefehl, z. B. pnpm test; leer entfernt ihn; landet in .forge/project.json im Repo",
      dev_command: "settings: Befehl für den Dev-Server, z. B. pnpm dev; leer nimmt den erkannten; landet in .forge/project.json im Repo",
    },
  },
  files: {
    description: "Dateien eines Projekts oder einer Session ansehen. list: Inhalt eines Ordners (ohne path das Projektverzeichnis). read: eine Textdatei lesen. find: eine Datei nach ihrem Namen suchen (path = Name oder Ende des Pfads).",
    params: {
      path: "Pfad relativ zum Projekt, z. B. src oder package.json",
    },
  },
  claude_md: {
    description: "Anweisungen an Claude Code in der CLAUDE.md. list: welche es gibt. read: vorlesen. append: text unten anhängen. scope global gilt für alle Projekte, project ist die CLAUDE.md im Projekt (wird committet), local gilt nur für ihn (CLAUDE.local.md), project-dir ist .claude/CLAUDE.md.",
    params: {
      project: "Projektname; weglassen für die globale CLAUDE.md",
      scope: "ohne Angabe: project, wenn ein Projekt genannt ist, sonst global",
      text: "nur bei append: die neue Anweisung, vollständig ausformuliert",
    },
  },
  sessions: {
    description: "Alle Sessions, auch ältere und geschlossene. list: auflisten, auf Wunsch nach project, Suchwörtern (query) oder status gefiltert; die Kürzel gelten danach für die anderen Werkzeuge. delete: eine Session löschen. delete_all: alle Sessions löschen. fork: Verlauf in eine neue Session abzweigen, ganz oder bis vor eine Nachricht (messages_back). handoff: eine lange Session in einer neuen fortsetzen; jede Nachricht schickt den ganzen Verlauf mit, eine lange Session verbraucht deshalb viel vom Limit. Claude fasst den Verlauf dabei einmal als Übergabe zusammen, die neue Session weiß alles und startet klein; die alte bleibt. rewind: Dateien auf den Stand vor einer Nachricht des Anrufers zurücksetzen; der Verlauf bleibt. edit: eine Nachricht des Anrufers durch text ersetzen; ein laufender Durchlauf bricht ab und Claude macht mit dem neuen Text weiter, als hätte es die alte Nachricht nie gegeben. ui_compare: ob es zum letzten Durchlauf einen Vorher-Nachher-Vergleich der Web-App gibt (Seite, geänderte UI-Dateien, Stand); die Bilder selbst gibt es nur am Computer. ui_compare_retake: das Nachher-Bild neu aufnehmen. templates: Prompt-Vorlagen auflisten (gespeicherte, wiederkehrende Aufträge mit Platzhaltern wie {datei}), mit project die globalen und die des Projekts. template_send: eine Vorlage (template) mit Werten für ihre Platzhalter (values) an eine Session schicken (session) oder damit eine neue Session im project starten; fehlen Werte, nennt FORGE sie, dann den Anrufer danach fragen. template_save: eine Vorlage anlegen (name, text, optional description, mit project nur für dieses Projekt) oder mit template eine vorhandene ändern. template_delete: eine Vorlage löschen. template_move: eine Vorlage in ihrer Liste nach oben oder unten schieben (direction). template_learn: jetzt aus den letzten Nachrichten wiederkehrende Aufträge als Vorlagen lernen (das macht FORGE sonst von selbst, gelernte Vorlagen sind markiert). day_report: Tagesbericht für „Was ist heute passiert?“: Sessions mit Durchläufen, Agenten (zusammengeführt, verworfen, wartend), Commits, was offen ist und die Anrufe; mit summary eine kurze Zusammenfassung von Claude.",
    params: {
      session: "bei delete, fork, handoff, rewind, edit, ui_compare und ui_compare_retake: Kürzel wie S1 oder ein Teil des Titels",
      project: "bei list und day_report: nur dieses Projekt",
      days_back: "bei day_report: welcher Tag, 0 heute (Standard), 1 gestern",
      summary: "bei day_report: true für eine kurze Zusammenfassung von Claude (dauert ein paar Sekunden)",
      query: "bei list: Wörter aus dem Titel",
      status: "bei list: nur Sessions in diesem Zustand",
      keep_transcript: "bei delete und delete_all: true behält den Verlauf bei Claude Code",
      messages_back: "bei fork, rewind und edit: welche Nachricht des Anrufers, vom Ende gezählt (1 = die letzte); fork ohne Angabe übernimmt den ganzen Verlauf",
      rewind_files: "bei fork: true setzt auch die Dateien auf den Stand vor dieser Nachricht zurück",
      text: "bei edit: der neue, vollständige Text der Nachricht; bei template_save: der Text der Vorlage mit Platzhaltern in geschweiften Klammern",
      template: "bei template_send, template_save, template_delete und template_move: Name der Vorlage oder ein Teil davon",
      values: "bei template_send: Werte für die Platzhalter der Vorlage",
      "values.name": "Name des Platzhalters ohne Klammern, etwa datei",
      "values.value": "Wert",
      name: "bei template_save: Name der Vorlage",
      description: "bei template_save: wofür die Vorlage ist",
      direction: "bei template_move: nach oben (up) oder unten (down)",
    },
  },
  extensions: {
    description: "Erweiterungen von Claude Code, global (scope user) oder für ein Projekt. kind mcp: MCP-Server auflisten, mit add (target ist Befehl oder URL) hinzufügen, mit remove entfernen. kind skill oder agent: Skills und Subagenten auflisten, mit read vorlesen, mit add und description anlegen, mit remove löschen. kind command: eigene Slash-Befehle auflisten. kind hook: Hooks vorlesen (ändern nur in FORGE). kind plugin: installierte Plugins auflisten oder mit query im Katalog suchen, mit add installieren, remove deinstallieren, enable und disable schalten.",
    params: {
      project: "Projektname, wenn es um ein Projekt geht",
      name: "Name des Servers, Skills, Subagenten oder Plugins",
      scope: "user: global; project: im Projekt, wird committet; local: nur für ihn im Projekt",
      description: "skill und agent bei add: wofür er da ist, vollständig ausformuliert",
      transport: "mcp bei add: ohne Angabe http für URLs, sonst stdio",
      target: "mcp bei add: Befehl oder URL des Servers",
      args: "mcp bei add: Argumente des Befehls, durch Leerzeichen getrennt",
      query: "plugin bei list: Suchwörter für den Katalog",
    },
  },
  forge_settings: {
    description: "Globale Einstellungen von FORGE. Nur angeben, was sich ändern soll; ohne Angaben sagt es den Stand. policy_rule mit policy_rule_on schaltet eine Regel der Sperrliste, die Claude gefährliche Befehle verbietet; ausschalten nur, wenn der Anrufer das ausdrücklich will.",
    params: {
      default_model: "Standardmodell neuer Sessions: opus, sonnet, haiku oder eine Modell-ID; default nimmt das von Claude Code",
      default_effort: "Standard-Denkaufwand; default nimmt den von Claude Code",
      default_profile: "Profil neuer Projekte",
      default_project_dir: "Ordner, in dem neue Projekte angelegt werden",
      sounds: "Töne",
      desktop_notifications: "Benachrichtigungen von Windows",
      enter_to_send: "Enter sendet die Nachricht",
      auto_continue: "nach einem Nutzungslimit automatisch weitermachen",
      idle_close_minutes: "nach wie vielen Minuten ohne Aktivität FORGE den Claude-Prozess einer Session schließt (sie bleibt erhalten); 0 schaltet das aus. In den Einstellungen wählbar: 15, 30, 60, 120, 240",
      long_session_tokens: "ab wie vielen Tokens Kontext FORGE vorschlägt, in einer neuen Session weiterzumachen; 0 schaltet den Hinweis aus. In den Einstellungen wählbar: 100000, 200000, 400000, 800000",
      update_checks: "nach Updates von FORGE suchen",
      update_channel: "woher FORGE Updates bekommt: stable sind die Releases von main, dev die Vorabversionen aus dem Branch dev. dev geht nur, wenn das GitHub-Konto in FORGE Schreibrecht auf das FORGE-Repository hat",
      debug_logs: "ausführliche Protokolle",
      strip_api_key: "einen API-Key aus der Umgebung nicht an Claude Code geben, damit das Abo zählt",
      screenshot_key: "die Druck-Taste öffnet das Snipping-Tool von FORGE statt dem von Windows",
      ui_compare: "Vorher-Nachher-Bilder der Web-App, wenn Claude UI-Dateien ändert und ein Dev-Server läuft",
      learn_templates: "FORGE macht aus Aufträgen, die der Anrufer immer wieder schickt, von selbst Prompt-Vorlagen",
      ask_push_on_close: "beim Schließen von FORGE fragen, ob alles noch nicht Gepushte committet und gepusht werden soll",
      usage_stats: "anonyme Nutzungsstatistik: alle 5 Minuten Summen wie Tokens, Projekte und Agenten ohne Inhalte an den Statistik-Dienst von FORGE; aus löscht die gesendeten Daten dort",
      language: "Sprache von FORGE für Oberfläche, Meldungen und Telefon: en Englisch, de Deutsch. Danach sprichst du in der neuen Sprache",
      policy_rule: "Regel der Sperrliste",
      policy_rule_on: "true schaltet die Regel ein, false aus",
    },
  },
  forge_system: {
    description: "FORGE selbst. diagnostics: ob Claude Code, Anmeldung, Git, GitHub-CLI und Python in Ordnung sind. update_check: nach einer neuen FORGE-Version suchen. update_download: sie herunterladen. update_install: sie installieren; FORGE startet dabei neu und das Gespräch endet, offene Sessions machen danach von selbst weiter. Nur wenn der Anrufer das ausdrücklich will, und vorher sagen, dass das Gespräch endet. changelog: was die neue Version bringt. install_check: ob FORGE vollständig installiert ist (mitgelieferte Programme wie Git und GitHub CLI in der Version, die diese FORGE-Version braucht) und welcher Installer das behebt. install_repair: FORGE mit dem vollständigen Installer neu installieren; FORGE startet dabei neu und das Gespräch endet, offene Sessions machen danach weiter. Läuft erst nach einem Tastatur-Code. dev_status: ob FORGE Updates aus main oder dev bekommt und was dev hat, das main noch nicht hat (nur für Mitglieder des FORGE-Repositorys). dev_promote: dev auf GitHub nach main übernehmen und das Release von main starten; alle Nutzer des stabilen Kanals bekommen es als Update. Geht nur, solange update_channel dev ist. Nur wenn der Anrufer das ausdrücklich will, läuft erst nach einem Tastatur-Code. claude_check: ob es ein Update von Claude Code gibt. claude_update: Claude Code aktualisieren (oder installieren, wenn es fehlt). claude_logout: Claude Code auf diesem Computer abmelden; neu anmelden geht nur am Rechner, nur wenn der Anrufer das ausdrücklich will. backup_list: die letzten Backups. backup_create: Backup anlegen. backup_restore: ein Backup wiederherstellen; vorher sichert FORGE den jetzigen Stand. Nur wenn der Anrufer das ausdrücklich will. sync_status: ob die Daten von FORGE über ein privates, verschlüsseltes GitHub-Repository mit anderen Computern abgeglichen werden, wann zuletzt, welche Projekte anderer Computer hier noch fehlen und was nur noch auf diesem Computer ist. sync_now: sofort abgleichen. sync_on und sync_off: den Abgleich ein- oder ausschalten. sync_clone: ein Projekt von einem anderen Computer hierher holen (project). sync_keep: etwas, das nur noch hier ist, wieder abgleichen (project: Name aus sync_status). sync_force: diesen Computer hart auf den Stand von GitHub setzen, mit project nur diesen Eintrag; entfernt hier, was auf GitHub fehlt, nur wenn der Anrufer das ausdrücklich will. sync_versions: frühere Stände auf GitHub. sync_restore: einen früheren Stand zurückholen (backup: Nummer aus sync_versions, parts wie bei backup_restore). support: wie man für FORGE spenden und wo man Verbesserungen oder Featurevorschläge einreichen kann.",
    params: {
      backup: "bei backup_restore: Nummer aus backup_list, bei sync_restore aus sync_versions (1 = neuestes)",
      project: "bei sync_clone, sync_keep und sync_force: Name aus sync_status",
      parts: "bei backup_restore und sync_restore: welche Teile, durch Komma getrennt: settings, projects, claude, git; ohne Angabe alle außer den Telefon-Einstellungen",
    },
  },
  ask: {
    description:
      "Beantwortet eine Frage zum Inhalt der Sessions aus ihrem Verlauf, etwa „Was ist das Konzept hinter dem Ultrathink-Test?“, „Woran hängt der Export?“, „Wie würdest du das Projekt bewerten?“ oder „Was haben wir gestern beim Login gemacht?“. Claude liest dafür die passenden Verläufe, das dauert ein paar Sekunden. Ohne session sucht FORGE selbst die Sessions, die zur Frage passen. Für Fragen zu Inhalt, Gründen und Hintergründen, die über den letzten Stand hinausgehen; den Stand selbst liefert details schneller.",
    params: {
      question: "die Frage des Anrufers, vollständig ausformuliert, mit dem Thema oder Namen, um das es geht",
      session: "nur diese Session: Kürzel wie S1 oder Teil des Titels; weglassen, wenn unklar ist, welche gemeint ist",
      project: "nur die Sessions dieses Projekts",
    },
  },
  search: {
    description:
      "Volltextsuche in den Verläufen der Sessions (Nachrichten, Antworten, Befehle und Dateipfade), etwa „In welcher Session haben wir den Stripe-Webhook gebaut?“. Alle Suchwörter müssen vorkommen, die Reihenfolge ist egal. Ohne session und project über alle Sessions: passende Sessions mit Textstelle. Mit session: die Stellen in dieser Session, die neueste zuerst. Mit project: nur die Sessions dieses Projekts.",
    params: {
      query: "Suchwörter",
      session: "nur in dieser Session suchen: Kürzel wie S1 oder Teil des Titels",
      project: "nur in den Sessions dieses Projekts suchen",
      phrase: "true: genau diese Wortfolge",
    },
  },
  usage: {
    description: "Nutzung des Claude-Abos: wie viel von den Limits verbraucht ist, wann sie zurückgesetzt werden, ob das Limit beim bisherigen Tempo bis zum Reset reicht (Prognose, etwa für „Reicht mein Limit noch?“) und wie viele Tokens pro Sekunde Claude gerade ausgibt.",
  },
  call_settings: {
    description: "Wann und wen FORGE von sich aus anruft: wenn eine Session fertig ist (done), wenn sie eine Entscheidung braucht oder Claude dringend meldet (approval), bei Fehlern (error). Alle drei false: keine Anrufe mehr. FORGE ruft alle eingeschalteten Nummern gleichzeitig an, wer zuerst abnimmt, hat das Gespräch. Mit number_action eine Nummer der Liste list ein- oder ausschalten (on, off), neu eintragen (add, mit label als Bezeichnung) oder löschen (remove); list notify sind die Nummern, die FORGE anruft, allowed die, die FORGE anrufen dürfen. number ist die Nummer oder ihre Bezeichnung wie Handy. Nur angeben, was sich ändern soll; ohne Angaben sagt es den Stand.",
    params: {
      list: "notify: Nummern, die FORGE anruft (Standard); allowed: Nummern, die FORGE anrufen dürfen",
      number: "Telefonnummer oder Bezeichnung eines Eintrags, z. B. Handy",
      label: "nur bei add: Bezeichnung der neuen Nummer, z. B. Büro",
    },
  },
  call_back: {
    description: "Vereinbart einen Rückruf: FORGE ruft den Anrufer nach der angegebenen Zeit an und sagt ihm dann, was er wissen wollte (frisch geprüft, nicht der Stand von jetzt).",
    params: {
      minutes: "In wie vielen Minuten, z. B. 5 (höchstens 1440)",
      about: "Was er beim Rückruf wissen will, vollständig ausformuliert, z. B. „ob die Tests der Session Warenkorb grün sind“",
    },
  },
  hang_up: {
    description: "Beendet das Telefonat, nachdem deine letzte Antwort gesprochen wurde.",
  },
};
