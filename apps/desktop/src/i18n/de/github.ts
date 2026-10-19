import { byPlatform } from "@/lib/platform";

/** German texts (github). Source of the keys: the English file is typed against this one. */
export const github = {
  deviceCode: {
    copied: "Code kopiert",
    notCopied: "Code nicht kopiert",
    noClipboard: "Die Zwischenablage ist nicht erreichbar. Bitte den Code abtippen.",
    oneTimeCode: "Einmal-Code",
    copy: "Code kopieren",
    openGitHub: "GitHub öffnen",
    cancel: "Abbrechen",
    waiting: "Warte auf Bestätigung",
  },
  owner: {
    loading: "Lädt Organisationen",
    personal: "Persönliches Konto",
    organization: "Organisation",
    aria: "Konto oder Organisation",
    loadFailed: "Organisationen konnten nicht geladen werden.",
  },
  account: {
    loginNotStarted: "Anmeldung nicht gestartet",
    loading: "Lädt GitHub-Konto",
    profile: "Profil",
    signOut: "Abmelden",
    logoutTitle: "Von GitHub abmelden?",
    logoutDescription: "FORGE und git können danach nicht mehr auf deine privaten Repositories zugreifen, bis du dich erneut anmeldest.",
    logoutFailed: "Abmelden fehlgeschlagen",
    codePrompt: "Gib diesen Code auf der GitHub-Seite ein, die sich im Browser geöffnet hat:",
    cancelFailed: "Abbrechen fehlgeschlagen",
    intro:
      `Melde dich an, um private Repositories zu klonen, zu pushen und Pull Requests zu erstellen. Die Anmeldung läuft über GitHub im Browser; das Token liegt ${byPlatform({ windows: "im Windows-Anmeldeinformationsspeicher", macos: "im macOS-Schlüsselbund", linux: "bei der GitHub CLI" })}, nicht in FORGE.`,
    loginFailed: "Anmeldung fehlgeschlagen",
    signIn: "Mit GitHub anmelden",
  },
  repos: {
    searchPlaceholder: (login: string) => `Repositories von ${login} durchsuchen`,
    searchAria: "Repositories durchsuchen",
    loading: "Lädt Repositories",
    listAria: "Deine Repositories",
    private: "privat",
    updated: (when: string) => `aktualisiert ${when}`,
    noResults: "Keine Treffer",
  },
};
