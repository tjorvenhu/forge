import type { teams as De } from "../../de/core/teams.js";

export const teams: typeof De = {
  notATeam: "This session is not an agent team.",
  disabled: "Agent teams are switched off in the settings.",
  disabledInProject: (name) => `Agent teams are switched off in ${name}. You can allow them again in the project settings.`,
};
