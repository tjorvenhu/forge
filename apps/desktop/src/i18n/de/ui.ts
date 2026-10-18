/** German texts (ui). Source of the keys: the English file is typed against this one. */
export const ui = {
  close: "Schließen",
  cancel: "Abbrechen",
  info: "Info",
  error: "Fehler",
  selectPlaceholder: "Auswählen",
  loading: "Lädt",
  loadingEllipsis: "Lädt …",
  loadingPreview: "Lädt Vorschau",
  loadingEditor: "Lädt Editor",
  loadingHistory: "Lädt Verlauf",
  closeTab: (label: string) => `${label} schließen`,
  /** Around the text the user has to type: "Zur Bestätigung <text> eingeben". */
  confirmType: { before: "Zur Bestätigung", after: "eingeben" },
  codeView: {
    truncated: "Vorschau auf 512 KB gekürzt",
    lines: (n: number) => (n === 1 ? "1 Zeile" : `${n} Zeilen`),
    plainText: "Nur Text",
  },
  fileDraft: {
    changedOutside: "Die Datei wurde außerhalb von FORGE geändert.",
    changedOutsideHint: "Neu laden verwirft deine Änderungen. Wenn du weiter bearbeitest, überschreibt Speichern die Datei.",
    reload: "Neu laden",
    keepEditing: "Weiter bearbeiten",
  },
};
