import type { teams as De } from "../../de/core/teams.js";

export const teams: typeof De = {
  teamNotFound: (name, known) => (known ? `No agent team "${name}". Known: ${known}.` : `No agent team "${name}". None is running.`),
  teamEnded: (name) => `The agent team ${name} has ended; its lead session is no longer running.`,
  memberNotFound: (name, known) => `No member "${name}" in the team. Members: ${known}.`,
  noTeammates: "The team has no teammates yet.",
  inboxBusy: "The inbox is locked right now. Please try again in a moment.",
  fromForge: "Message from FORGE",
  noWindow: "FORGE's main window is not open; the team terminal starts there.",
  disabled: "Agent teams are switched off in the settings.",
  disabledInProject: (name) => `Agent teams are switched off in ${name}. You can allow them again in the project settings.`,
  cannotStop: "FORGE does not know the lead's process. End the team in its terminal, for example with /exit.",
  stillRunning: (name) => `The agent team ${name} is still running. End it first, then remove it.`,
  projectMissing:"Project not found.",
  folderMissing: "The project folder is missing.",
};
