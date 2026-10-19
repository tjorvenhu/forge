import path from "node:path";
import type { SessionEvent } from "@forge/protocol";

/**
 * Decides whether auto-test has to run after a turn: only for changes that can affect tests, and
 * not when Claude already ran the project's tests after its last change.
 */

const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

const DOC_FILE = /\.(md|markdown|rst|adoc)$|(^|\/)(LICEN[CS]E|CHANGELOG|AUTHORS|NOTICE)(\.\w+)?$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|psd)$/i;
const NO_TEST_DIR = /^(\.forge\/knowledge|\.claude|\.vscode|\.idea)\//;
/** Docs and images in these folders are often test input (fixtures, snapshots). */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|fixtures|__fixtures__|__snapshots__|testdata|e2e)\//i;

/** False for files no test can depend on: docs, images, project knowledge, editor settings. Path relative to the project. */
export function isTestRelevant(file: string): boolean {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (NO_TEST_DIR.test(f)) return false;
  if (TEST_DIR.test(f)) return true;
  return !DOC_FILE.test(f) && !IMAGE_FILE.test(f);
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** flags that change neither what runs nor whether it fails */
const NEUTRAL_FLAG = /^(--silent|-s|--run|--|--no-color|--color|--reporter=\S+|--reporters=\S+)$/;
const SCRIPT_TEST = "<script:test>";

/** Splits a shell command into its parts at &&, ||, ;, | and line breaks (quotes are not parsed). */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

/** Leading VAR=value assignments and harmless stderr redirects removed. */
function stripNoise(segment: string): string {
  return segment
    .replace(/\s+2>&1\b/g, "")
    .replace(/^(\$env:\w+\s*=\s*\S+\s*)+/i, "")
    .replace(/^(\w+=\S*(\s+|$))+/, "")
    .trim();
}

/** Canonical form of a test command: `npm run test`, `pnpm test` and `yarn test` all run the test script. */
export function canonicalCommand(segment: string): string {
  let tokens = stripNoise(segment)
    .split(/\s+/)
    .filter((t) => !NEUTRAL_FLAG.test(t));
  if (!tokens.length) return "";
  if (PACKAGE_MANAGERS.has(tokens[0]!)) {
    tokens = tokens.map((t) => (t === "--recursive" ? "-r" : t));
    const runAt = tokens.findIndex((t, i) => i > 0 && !t.startsWith("-"));
    if (tokens[runAt] === "run") tokens.splice(runAt, 1);
    if (tokens.length === 2 && tokens[1] === "test") return SCRIPT_TEST;
  } else if (tokens[0] === "bun" && tokens[1] === "run" && tokens[2] === "test" && tokens.length === 3) {
    return SCRIPT_TEST;
  }
  return tokens.join(" ");
}

/** The forms that run the whole test suite of the project; `rootTestScript` is scripts.test of its package.json. */
export function equivalentTestCommands(testCommand: string, rootTestScript: string | null): Set<string> {
  const own = canonicalCommand(testCommand);
  const forms = new Set([own]);
  if (rootTestScript) {
    const script = canonicalCommand(rootTestScript);
    if (own === SCRIPT_TEST && script) forms.add(script);
    if (script === own) forms.add(SCRIPT_TEST);
  }
  forms.delete("");
  return forms;
}

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "grep", "egrep", "rg", "wc", "echo", "printf", "pwd", "which", "where", "file", "stat", "du", "df",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "jq", "true", "false", "test", "[", "date", "env", "printenv", "basename", "dirname", "realpath",
  "readlink", "tree", "less", "more", "sleep", "cd", "pushd", "popd", "set", "export",
  "get-childitem", "gci", "get-content", "gc", "select-string", "sls", "select-object", "measure-object", "test-path", "get-location",
  "write-output", "write-host", "sort-object", "where-object", "format-table", "format-list", "out-string", "resolve-path", "get-item",
]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "add", "commit", "push", "fetch", "remote", "describe", "shortlog", "reflog", "tag", "config", "worktree"]);
const CHECK_WORD = /^(test|tests|typecheck|type-check|lint|check|build|vitest|jest|mocha|playwright|pytest|tsc|vue-tsc|eslint|clippy|vet)(:[\w:-]+)?$/;
const MODIFY_FLAG = /^(--fix|--write|-u|--update|--update-snapshots?|--updatesnapshot)$/i;
const CHECK_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx", "cargo", "go", "python", "python3", "py", "uv"]);

/** True when the shell part can change files: anything that is not a known read-only, git or test/check command. */
function mayModify(segment: string): boolean {
  const s = stripNoise(segment);
  if (/(^|[^0-9&])>{1,2}(?!\s*(\/dev\/null|\$null|nul)\b)/i.test(s.replace(/\d>&\d/g, ""))) return true;
  const tokens = s.split(/\s+/).map(unquote);
  const cmd = tokens[0]?.toLowerCase() ?? "";
  if (!cmd) return false;
  if (READ_ONLY_COMMANDS.has(cmd)) return false;
  if (cmd === "sed") return tokens.some((t) => /^(-i|--in-place)/.test(t));
  if (cmd === "find") return tokens.some((t) => /^-(delete|exec|execdir|ok)$/.test(t));
  if (cmd === "git") {
    const sub = tokens.slice(1).find((t, i, a) => !t.startsWith("-") && a[i - 1] !== "-C" && a[i - 1] !== "-c");
    if (sub === "stash") return !["list", "show"].includes(tokens[tokens.indexOf("stash") + 1] ?? "");
    return !sub || !READ_ONLY_GIT.has(sub);
  }
  if (tokens.some((t) => MODIFY_FLAG.test(t))) return true;
  const words = (CHECK_RUNNERS.has(cmd) ? tokens.slice(1) : tokens).filter((t) => !t.startsWith("-")).slice(0, 4);
  return !words.some((w) => CHECK_WORD.test(w));
}

/** Directory a `cd` part switches to, or null when the part is no cd. */
function cdTarget(segment: string, from: string): string | null {
  const m = /^(cd|pushd|set-location|sl)\s+(.+)$/i.exec(stripNoise(segment));
  if (!m) return null;
  let target = unquote(m[2]!.trim().replace(/^-LiteralPath\s+|^-Path\s+/i, ""));
  // Git Bash paths: /c/Users/... is C:/Users/... (elsewhere /c is a folder of its own)
  if (process.platform === "win32") target = target.replace(/^\/([a-z])(\/|$)/i, (_, d: string) => `${d.toUpperCase()}:/`);
  return path.resolve(from, target);
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const FAIL_MARK = /\b[1-9]\d* (failed|failing|errors?)\b|\bFAIL\b|ERR_PNPM|ELIFECYCLE|npm ERR!|Command failed|exit(ed with)? code [1-9]|test result: FAILED|^FAILED\b/im;
const PASS_MARK = /\b\d+ (passed|passing)\b|test result: ok|^ok\s/im;

/**
 * Whether a run's output shows success. With a pipe, `;` or `||` the exit code belongs to another
 * command (e.g. `pnpm test | tail -20`), so the output has to show passing tests and no failure.
 */
function succeeded(command: string, result: { isError: boolean; text: string; truncated: boolean }): boolean {
  if (result.isError) return false;
  if (!/\||;/.test(command)) return true;
  return !result.truncated && PASS_MARK.test(result.text) && !FAIL_MARK.test(result.text);
}

export interface TurnAnalysis {
  /** files written with the edit tools, relative to the project folder, only those inside it */
  edited: string[];
  /** a shell command that may have changed files ran (anything but read-only, git and test/check commands) */
  shellChanges: boolean;
  /** Claude ran the full test command successfully, and after it changed nothing that can affect tests */
  testedAfterLastChange: boolean;
  /** working directory of Claude's shell at the end (cd persists between calls) */
  shellDir: string;
}

/**
 * Reads the tool calls of a turn (tool.use/tool.result events, subagents included). `shellDir` is
 * where Claude's shell was at the start of the turn, the project folder when unknown.
 */
export function analyzeTurn(events: SessionEvent[], cwd: string, testForms: ReadonlySet<string>, shellDir = cwd): TurnAnalysis {
  const results = new Map<string, { isError: boolean; text: string; truncated: boolean }>();
  for (const e of events) {
    if (e.body.type === "tool.result") results.set(e.body.toolUseId, { isError: e.body.isError, text: e.body.content.text, truncated: e.body.content.truncated });
  }
  const edited = new Set<string>();
  let shellChanges = false;
  let tested = false;
  let dir = shellDir;
  for (const e of events) {
    const b = e.body;
    if (b.type !== "tool.use") continue;
    if (EDIT_TOOLS.has(b.name)) {
      const file = typeof b.input.file_path === "string" ? b.input.file_path : typeof b.input.notebook_path === "string" ? b.input.notebook_path : null;
      if (!file) continue;
      const rel = path.relative(cwd, path.resolve(cwd, file));
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      edited.add(rel.replace(/\\/g, "/"));
      if (isTestRelevant(rel)) tested = false;
      continue;
    }
    if (!SHELL_TOOLS.has(b.name) || typeof b.input.command !== "string") continue;
    const command = b.input.command;
    const background = b.input.run_in_background === true;
    let runsSuite = false;
    let changes = false;
    for (const seg of segments(command)) {
      const next = cdTarget(seg, dir);
      if (next) {
        dir = next;
        continue;
      }
      if (testForms.has(canonicalCommand(seg)) && sameDir(dir, cwd)) runsSuite = true;
      else if (mayModify(seg)) changes = true;
    }
    if (changes) {
      shellChanges = true;
      tested = false;
    }
    const result = results.get(b.toolUseId);
    if (runsSuite && !changes && !background && result && succeeded(command, result)) tested = true;
  }
  return { edited: [...edited], shellChanges, testedAfterLastChange: tested, shellDir: dir };
}

/**
 * In a pnpm workspace whose test command is `pnpm -r test` (directly or as the root test script):
 * the same command limited to the packages with changes and the packages depending on them.
 * Null when that is not safe to say (a changed file outside every package, another test command).
 */
export function scopedTestCommand(
  testCommand: string,
  rootTestScript: string | null,
  files: string[],
  isPackageDir: (dir: string) => boolean,
  isPnpmWorkspace: boolean,
): string | null {
  if (!isPnpmWorkspace || !files.length) return null;
  const own = canonicalCommand(testCommand);
  const recursive = own === "pnpm -r test" || (own === SCRIPT_TEST && rootTestScript !== null && canonicalCommand(rootTestScript) === "pnpm -r test");
  if (!recursive) return null;
  const dirs = new Set<string>();
  for (const f of files) {
    let dir = path.posix.dirname(f.replace(/\\/g, "/"));
    while (dir !== "." && dir !== "/" && dir !== "" && !isPackageDir(dir)) dir = path.posix.dirname(dir);
    if (dir === "." || dir === "/" || dir === "") return null;
    dirs.add(dir);
  }
  return `pnpm -r ${[...dirs]
    .sort()
    .map((d) => `--filter "...{./${d}}"`)
    .join(" ")} test`;
}
