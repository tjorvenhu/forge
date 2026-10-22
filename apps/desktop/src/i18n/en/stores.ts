import type { stores as De } from "../de/stores";

export const stores: typeof De = {
  autoSaved: "Saved automatically",
  terminalTab: (n: number) => `Terminal ${n}`,
  teamTab: "Agent team",
};
