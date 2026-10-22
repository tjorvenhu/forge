import type { app as De } from "../../de/core/app.js";

export const app: typeof De = {
  starting: "FORGE is still starting.",
  claudeMissing: "Claude Code is not installed.",
  invalidInput: (details) => `Invalid input: ${details}`,
  inputField: "input",
  unknownMethod: (method) => `Unknown method: ${method}`,
  invalidParams: "Invalid parameters",
  hasOrigin: "The project already has a remote origin.",
  busyRestore: "An active session is working in this project. Stop it first, then restore.",
  busyCheckout: "An active session is working in this project. Stop it first, then switch branches.",
  busyReset: "An active session is working in this project. Stop it first, then reset to the server's state.",
  mergingInSession: "Claude is merging the changes.",
  noBranch: "No branch checked out.",
  sameBranch: "Target and source branch are the same. Create a feature branch first.",
};
