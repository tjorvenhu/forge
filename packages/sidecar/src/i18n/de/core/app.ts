/** German texts (core.app). Source of the keys: the English file is typed against this one. */
export const app = {
  starting: "FORGE startet noch.",
  claudeMissing: "Claude Code ist nicht installiert.",
  invalidInput: (details: string) => `Ungültige Angaben: ${details}`,
  inputField: "Eingabe",
  unknownMethod: (method: string) => `Unbekannte Methode: ${method}`,
  invalidParams: "Ungültige Parameter",
  hasOrigin: "Das Projekt hat bereits ein Remote origin.",
  busyRestore: "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann wiederherstellen.",
  busyCheckout: "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann Branch wechseln.",
  busyReset: "Eine aktive Session arbeitet gerade in diesem Projekt. Erst stoppen, dann auf den Stand vom Server zurücksetzen.",
  mergingInSession: "Claude führt die Stände zusammen.",
  noBranch: "Kein Branch ausgecheckt.",
  sameBranch: "Ziel- und Quell-Branch sind gleich. Lege zuerst einen Feature-Branch an.",
};
