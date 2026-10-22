/**
 * Commands a member of an agent team may run without asking (profile Balanced): tests, lint, type
 * checks and reading commands. Five members asking for every test run would stall the team until
 * the user clicks. Kept narrow on purpose: no chaining except `cd dir &&`, no redirects, no
 * substitutions, nothing that installs, deletes or pushes.
 */

const READ_ONLY = new Set(["ls", "dir", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "which", "where", "tree", "stat", "file", "du"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "grep", "shortlog", "describe"]);
/** package scripts and tools that check, never install or publish */
const CHECK_SCRIPT = /^(test|tests|lint|typecheck|type-check|check|tsc|vitest|jest|eslint|biome|prettier|mocha|ava|playwright)(:[\w:-]+)?$/;
const CHECK_BIN = new Set(["vitest", "jest", "tsc", "eslint", "biome", "prettier", "mocha", "pytest", "ruff", "mypy", "pyright", "playwright"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
/** anything that could run a second command, write somewhere else or substitute output */
const UNSAFE = /[;|<>`&\n\r]|\$\(/;

/** `cd dir`, also with a quoted path that has spaces */
const CD = /^cd\s+("[^"]*"|'[^']*'|\S+)$/;

function words(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

/** pnpm/npm/yarn/bun with a check script: `pnpm test`, `pnpm --filter x run lint`, `npm run typecheck`, `pnpm exec vitest run` */
function packageCheck(w: string[]): boolean {
  const rest = w.slice(1).filter((x, i, all) => !x.startsWith("-") && !(i > 0 && all[i - 1] === "--filter") && !(i > 0 && all[i - 1] === "-C") && !(i > 0 && all[i - 1] === "--prefix"));
  const [first, second] = rest;
  if (!first) return false;
  if (first === "run" || first === "exec" || first === "x") return !!second && (CHECK_SCRIPT.test(second) || CHECK_BIN.has(second));
  return CHECK_SCRIPT.test(first);
}

function single(cmd: string, testCommand: string | null): boolean {
  const c = cmd.trim();
  if (!c) return false;
  if (testCommand && (c === testCommand.trim() || c.startsWith(`${testCommand.trim()} `))) return true;
  const w = words(c);
  const bin = (w[0] ?? "").toLowerCase().replace(/\.(cmd|exe)$/, "");
  if (READ_ONLY.has(bin)) return true;
  if (bin === "find") return !w.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(x));
  if (bin === "git") return GIT_READ.has(w[1] ?? "");
  if (PACKAGE_MANAGERS.has(bin)) return packageCheck(w);
  if (bin === "npx") return CHECK_BIN.has(w.find((x, i) => i > 0 && !x.startsWith("-")) ?? "");
  if (CHECK_BIN.has(bin)) return true;
  if (bin === "node") return w[1] === "--test" || (w[1] === "--check" && !!w[2]);
  if (bin === "deno") return ["test", "check", "lint", "fmt"].includes(w[1] ?? "") && w[2] !== "--fix";
  if (bin === "cargo") return ["test", "check", "clippy", "fmt"].includes(w[1] ?? "");
  if (bin === "go") return ["test", "vet"].includes(w[1] ?? "");
  if (bin === "dotnet") return w[1] === "test";
  if (bin === "python" || bin === "python3" || bin === "py") return w[1] === "-m" && ["pytest", "mypy", "ruff"].includes(w[2] ?? "");
  if (bin === "./gradlew" || bin === "gradle" || bin === "mvn" || bin === "./mvnw") return w.slice(1).every((x) => x === "test" || x === "check" || x.startsWith("-"));
  return false;
}

/** true: the command only checks or reads, a team member may run it without asking */
export function isTeamCheckCommand(command: string, testCommand: string | null = null): boolean {
  const c = command.trim().replace(/\s+2>&1$/, "");
  if (!c || UNSAFE.test(c.replace(/&&/g, " "))) return false;
  const parts = c.split("&&").map((p) => p.trim());
  if (parts.some((p) => !p)) return false;
  // `cd dir && pnpm test`: changing into a folder is harmless, the last part must be a check
  return parts.every((p, i) => (i < parts.length - 1 && CD.test(p)) || single(p, testCommand)) && !/^cd\s/.test(parts.at(-1)!);
}
