import { execFileSync } from "node:child_process";
import path from "node:path";

/** The E2E tests talk to the bundled sidecar (dist/sidecar.mjs), so it is built fresh first. */
export default function setup() {
  execFileSync(process.execPath, ["build.mjs"], { cwd: path.join(import.meta.dirname, "..", ".."), stdio: "inherit" });
}
