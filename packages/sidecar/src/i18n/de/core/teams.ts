/** Agent teams of Claude Code (teams/agent-teams.ts). */
export const teams = {
  teamNotFound: (name: string, known: string) => (known ? `Kein Agent-Team „${name}“. Bekannt: ${known}.` : `Kein Agent-Team „${name}“. Gerade läuft keins.`),
  teamEnded: (name: string) => `Das Agent-Team ${name} ist beendet; seine Lead-Sitzung läuft nicht mehr.`,
  memberNotFound: (name: string, known: string) => `Kein Mitglied „${name}“ im Team. Mitglieder: ${known}.`,
  noTeammates: "Das Team hat noch keine Teammitglieder.",
  inboxBusy: "Das Postfach ist gerade gesperrt. Bitte gleich noch einmal versuchen.",
  fromForge: "Nachricht aus FORGE",
  noWindow: "Das Hauptfenster von FORGE ist nicht offen, dort startet das Team-Terminal.",
  disabled: "Agent-Teams sind in den Einstellungen ausgeschaltet.",
  disabledInProject: (name: string) => `In ${name} sind Agent-Teams ausgeschaltet. Sie lassen sich in den Projekt-Einstellungen wieder erlauben.`,
  cannotStop: "FORGE kennt den Prozess des Leads nicht. Beende das Team in seinem Terminal, zum Beispiel mit /exit.",
  stillRunning: (name: string) => `Das Agent-Team ${name} läuft noch. Erst beenden, dann entfernen.`,
  projectMissing:"Projekt nicht gefunden.",
  folderMissing: "Der Projektordner fehlt.",
};
