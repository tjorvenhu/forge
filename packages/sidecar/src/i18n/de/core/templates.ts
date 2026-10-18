/** German texts (core.templates). Source of the keys: the English file is typed against this one. */
export const templates = {
  notFound: "Diese Vorlage gibt es nicht mehr.",
  mixedOrder: "Globale Vorlagen und Vorlagen eines Projekts lassen sich nicht untereinander sortieren.",

  schemaName: "2 bis 4 Wörter zum Wiederfinden",
  schemaText: "der Auftrag an Claude, sauber formuliert, Platzhalter wie {datei}",
  schemaProject: "Projektname, wenn alle Vorkommen aus einem Projekt stammen, sonst null",
  schemaCount: "wie oft der Auftrag ungefähr vorkam",

  learnPrompt: (minRepeats: number) => [
    "Unten stehen Nachrichten, die ein Nutzer an Claude Code geschickt hat, neueste zuerst, jeweils mit dem Projekt in eckigen Klammern.",
    `Finde Aufträge, die er immer wieder schickt (mindestens ${minRepeats} Mal, gleich oder sinngemäß, auch mit Tippfehlern), und mach daraus höchstens 5 wiederverwendbare Prompt-Vorlagen.`,
    "Regeln:",
    "- Nur echte Wiederholungen. Keine Einzelfälle und keine bloßen Antworten wie „ja“, „danke“, „weiter“.",
    "- Ein Befehl aus ein, zwei Wörtern (etwa „push“) lohnt nur, wenn die Vorlage deutlich mehr sagt: dann den vollständigen Auftrag ausformulieren, so wie der Nutzer ihn meint.",
    "- text: Anweisung an Claude in der Sprache des Nutzers, ohne Tippfehler, knapp. Was sich von Mal zu Mal ändert, wird ein Platzhalter in geschweiften Klammern ohne Leerzeichen, etwa {datei}, {projekt}, {branch}, {thema}.",
    "- name: 2 bis 4 Wörter.",
    "- project: der Projektname aus den Klammern, wenn alle Vorkommen aus einem Projekt stammen, sonst null.",
    "- Nichts, was eine vorhandene Vorlage schon abdeckt, und nichts, was einer abgelehnten ähnelt.",
    "- Keine Passwörter, Schlüssel, Telefonnummern oder anderen persönlichen Daten.",
    "- Gibt es keine Wiederholungen, liefere eine leere Liste.",
  ],
  existing: "Vorhandene Vorlagen:",
  dismissed: "Abgelehnte Vorlagen:",
  messages: "Nachrichten:",
  none: "(keine)",

  tooFewMessages: (count: number, min: number) => `Noch zu wenige Nachrichten zum Lernen (${count} von ${min}).`,
  learnedFull: (max: number) => `Es gibt schon ${max} gelernte Vorlagen. Lösch nicht gebrauchte, dann lernt FORGE weitere.`,
  unreadableAnswer: "Claude hat keine lesbare Antwort geliefert.",
  learnedDescription: (count: number) => `Gelernt aus etwa ${count} ähnlichen Nachrichten`,
  learned: (names: string[]) => `${names.length === 1 ? "Neue Vorlage" : `${names.length} neue Vorlagen`} gelernt: ${names.join(", ")}.`,
  nothingNew: "Keine neuen wiederkehrenden Aufträge gefunden.",
};
