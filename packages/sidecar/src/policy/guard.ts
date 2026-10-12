import os from "node:os";
import path from "node:path";
import type { PolicyRuleId } from "@forge/protocol";
import { isInside, sensitivePaths } from "../util/paths.js";

export interface GuardContext {
  projectDir: string;
  confineWritesToProject: boolean;
  /** current branch of the project, if known; used for push-to-protected checks */
  currentBranch: string | null;
  /** defaults to os.homedir(); `~` in tool paths resolves against it */
  home?: string;
  /** folders outside the project that may still be written to (Claude Code's plan files) */
  extraWriteDirs?: string[];
  /** rules the user switched off in the settings */
  disabledRules?: ReadonlySet<PolicyRuleId>;
}

export interface GuardViolation {
  rule: string;
  message: string;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_TOOLS = new Set([...WRITE_TOOLS, "Read", "Glob", "Grep", "LS"]);
/** Tools that walk a directory tree; a root above a credentials folder can reach it. */
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// Segments are separated by shell control operators so one command can't hide behind another.
const SEP = String.raw`[^;&|\n]*`;
const GIT_PUSH = String.raw`\bgit\b${SEP}\bpush\b${SEP}`;

const GIT_RULES: Array<{ rule: PolicyRuleId; re: RegExp; message: string }> = [
  {
    rule: "git-force-push",
    re: new RegExp(String.raw`${GIT_PUSH}(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f\b|\s["']?\+[^\s]+)`),
    message: "Force-Push ist in FORGE gesperrt.",
  },
  {
    rule: "git-push-mirror",
    // --mirror and --prune delete remote refs that do not exist locally.
    re: new RegExp(String.raw`${GIT_PUSH}\s--(mirror|prune)\b`),
    message: "git push --mirror/--prune ist in FORGE gesperrt.",
  },
  {
    rule: "git-push-protected",
    re: new RegExp(String.raw`${GIT_PUSH}(?:\s|:)["']?(?:refs/heads/)?(main|master)["']?(?=$|[\s;&|])`),
    message: "Push auf main/master ist in FORGE gesperrt.",
  },
  {
    rule: "git-push-delete",
    re: new RegExp(String.raw`${GIT_PUSH}(\s--delete\b|\s-d\b|\s["']?:[^\s]+)`),
    message: "Remote-Branches löschen ist in FORGE gesperrt.",
  },
  {
    rule: "git-reset-hard",
    re: new RegExp(String.raw`\bgit\b${SEP}\breset\b${SEP}--hard\b`),
    message: "git reset --hard ist in FORGE gesperrt.",
  },
  {
    rule: "git-branch-delete",
    re: new RegExp(String.raw`\bgit\b${SEP}\bbranch\b${SEP}(\s-[a-zA-Z]*[dD]\b|\s--delete\b)`),
    message: "Branches löschen ist in FORGE gesperrt.",
  },
  {
    rule: "git-clean-force",
    re: new RegExp(String.raw`\bgit\b${SEP}\bclean\b${SEP}\s-[a-zA-Z]*f`),
    message: "git clean -f ist in FORGE gesperrt.",
  },
];

const FORMAT_DISK = /\b(format(\.com)?\s+[A-Za-z]:|mkfs(\.\w+)?\s|Format-Volume\b|diskpart\b)/i;

const UNIX_DELETE = new Set(["rm"]);
const WIN_DELETE = new Set(["remove-item", "ri", "rd", "rmdir", "del", "erase"]);

/**
 * Filesystem root, a drive root or the home folder, as a shell argument after quotes are removed and a
 * trailing separator or wildcard is cut off: /, /*, ~, ~/, $HOME, ${HOME}, C:\, C:/*, /c/ (Git Bash),
 * /mnt/c, $env:USERPROFILE\*.
 */
const ROOT_TARGET =
  /^(|~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME|HOMEDRIVE|SystemDrive)|\$\{env:(USERPROFILE|HOME)\}|%(USERPROFILE|HOMEDRIVE|SystemDrive)%|[A-Za-z]:|\/[A-Za-z]|\/mnt\/[A-Za-z]|\/cygdrive\/[A-Za-z])$/i;

function isRootTarget(arg: string): boolean {
  if (!arg) return false;
  const trimmed = arg.replace(/([\\/]+\.?)*([\\/]+\*(\.\*)?)?$/, "").replace(/[\\/]+$/, "");
  return ROOT_TARGET.test(trimmed);
}

/** Splits a command line into words per control-operator segment; quotes are removed, not interpreted. */
function shellSegments(command: string): string[][] {
  return command
    .split(/[;&|\n()`]/)
    .map((seg) => (seg.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/["']/g, "")))
    .filter((words) => words.length > 0);
}

/** First recursive delete of a root/home target in the command: "unix", "win" or null. */
function rootDelete(command: string): "unix" | "win" | null {
  for (const words of shellSegments(command)) {
    for (let i = 0; i < words.length; i++) {
      const name = (words[i]!.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
      const unix = UNIX_DELETE.has(name);
      if (!unix && !WIN_DELETE.has(name)) continue;
      let recursive = false;
      let options = true;
      const targets: string[] = [];
      for (const w of words.slice(i + 1)) {
        if (options && w === "--") {
          options = false;
        } else if (options && w.startsWith("--")) {
          if (w === "--recursive") recursive = true;
        } else if (options && /^-[a-zA-Z]/.test(w)) {
          // -rf, -R, PowerShell -Recurse (or -Path:C:\); -Force matches too, which only makes this stricter
          const [flag = "", value] = w.split(/:(.*)/s);
          if (/r/i.test(flag)) recursive = true;
          if (value) targets.push(value);
        } else if (options && !unix && /^\/[a-zA-Z]$/.test(w)) {
          // cmd.exe switches like /s /q
          if (/^\/s$/i.test(w)) recursive = true;
        } else {
          targets.push(w);
        }
      }
      // Windows deletes of a drive or home root are refused even without a recursive switch.
      if ((recursive || !unix) && targets.some(isRootTarget)) return unix ? "unix" : "win";
    }
  }
  return null;
}

const SENSITIVE_SEGMENTS =
  /(^|[\\/\s"'=~])(\.ssh|\.aws|\.gnupg|\.git-credentials|\.kube|\.credentials\.json)([\\/\s"']|$)|gh[\\/]hosts\.yml|GitHub CLI[\\/]hosts|(Chrome|Edge|Chromium|BraveSoftware)[\\/].*User Data|Firefox[\\/]Profiles|Microsoft[\\/](Credentials|Protect)/i;

/** Credential files that are only sensitive in the home folder (a project's own .npmrc is fine). */
const HOME_SECRET_FILE = String.raw`[\\/]+(\.npmrc|\.netrc|\.pgpass|\.docker[\\/]+config\.json|\.config[\\/]+gh)(?=[\\/\s"']|$)`;

function homeSecretPattern(home: string): RegExp {
  const literal = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, String.raw`[\\/]+`);
  return new RegExp(String.raw`(~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME)|%USERPROFILE%|${literal})["']?${HOME_SECRET_FILE}`, "i");
}

function pathFields(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}

export function isSensitivePath(p: string, home?: string): boolean {
  return sensitivePaths(home).some((s) => isInside(p, s)) || SENSITIVE_SEGMENTS.test(p);
}

/** True if a credentials folder or file lies inside `dir` (or is `dir`). */
function containsSensitive(dir: string, home?: string): boolean {
  return isSensitivePath(dir, home) || sensitivePaths(home).some((s) => isInside(s, dir));
}

export function resolveToolPath(p: string, projectDir: string, home: string = os.homedir()): string {
  const expanded = p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(home, p.slice(1)) : p;
  return path.resolve(projectDir, expanded);
}

/** Where Claude Code keeps plan files in plan mode; written outside the project by design. */
export function claudePlansDir(home = os.homedir()): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "plans");
}

/** True if a file tool would write outside the project (and outside the extra write folders). */
export function writesOutsideProject(toolName: string, input: Record<string, unknown>, projectDir: string, home?: string, extraWriteDirs: string[] = []): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false;
  return pathFields(input).some((p) => {
    const abs = resolveToolPath(p, projectDir, home);
    return !isInside(abs, projectDir) && !extraWriteDirs.some((d) => isInside(abs, d));
  });
}

const GLOB_CHARS = /[*?[\]{}!]/;

/** Literal leading directories of a glob, e.g. "src/**\/*.ts" -> "src"; "" when it starts with a wildcard. */
function literalPrefix(glob: string): { prefix: string; wildcard: boolean } {
  const parts = glob.split(/[\\/]/);
  const idx = parts.findIndex((s) => GLOB_CHARS.test(s));
  if (idx === -1) return { prefix: glob, wildcard: false };
  // keep a leading "/" or drive of an absolute glob
  return { prefix: parts.slice(0, idx).join("/") || (glob.startsWith("/") || glob.startsWith("\\") ? "/" : ""), wildcard: true };
}

/**
 * Glob and Grep walk a tree (hidden folders included), so a search rooted above ~/.ssh reaches it even
 * when the root itself is harmless. Allowed only when the glob narrows the search to a literal subfolder
 * that holds no credentials.
 */
function searchViolation(toolName: string, input: Record<string, unknown>, ctx: GuardContext, home: string): GuardViolation | null {
  const root = resolveToolPath(typeof input.path === "string" && input.path ? input.path : ".", ctx.projectDir, home);
  // Grep's `pattern` is a content regex; its file filter is `glob`. Glob's `pattern` is the file glob.
  const glob = toolName === "Glob" ? input.pattern : input.glob;
  const globs = typeof glob === "string" && glob ? [glob] : [];
  const blocked = (what: string): GuardViolation => ({
    rule: "sensitive-path",
    message: `Suche über ${what} ist gesperrt: der Ordner enthält Zugangsdaten (z. B. ~/.ssh). Bitte einen Unterordner angeben.`,
  });
  for (const g of globs) {
    if (SENSITIVE_SEGMENTS.test(g)) return blocked(g);
  }
  if (!containsSensitive(root, home)) {
    // An absolute glob ignores the root and may point anywhere.
    for (const g of globs) {
      const { prefix, wildcard } = literalPrefix(g);
      if (!(path.isAbsolute(prefix) || prefix.startsWith("~"))) continue;
      const target = resolveToolPath(prefix, root, home);
      if (wildcard ? containsSensitive(target, home) : isSensitivePath(target, home)) return blocked(g);
    }
    return null;
  }
  // Root above a credentials folder: a filename-only Grep glob (no separator) still matches at any depth.
  for (const g of globs) {
    if (toolName === "Grep" && !/[\\/]/.test(g)) continue;
    const { prefix, wildcard } = literalPrefix(g);
    if (!prefix) continue;
    const target = resolveToolPath(prefix, root, home);
    if (wildcard ? !containsSensitive(target, home) : !isSensitivePath(target, home)) return null;
  }
  return blocked(typeof input.path === "string" && input.path ? input.path : root);
}

/**
 * Hard rules that apply to every profile, including bypassPermissions.
 * Returns the first violation or null.
 */
export function checkToolUse(toolName: string, input: Record<string, unknown>, ctx: GuardContext): GuardViolation | null {
  const home = ctx.home ?? os.homedir();
  const on = (rule: PolicyRuleId) => !ctx.disabledRules?.has(rule);
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input.command === "string" ? input.command : "";
    for (const r of GIT_RULES) {
      if (on(r.rule) && r.re.test(command)) return { rule: r.rule, message: r.message };
    }
    const del = on("rm-root") ? rootDelete(command) : null;
    if (del === "unix") return { rule: "rm-root", message: "Rekursives Löschen von Wurzel- oder Home-Verzeichnis ist gesperrt." };
    if (del === "win") return { rule: "rm-root-win", message: "Löschen von Laufwerks- oder Home-Wurzel ist gesperrt." };
    if (on("format-disk") && FORMAT_DISK.test(command)) return { rule: "format-disk", message: "Datenträger formatieren ist gesperrt." };
    if (on("sensitive-path") && (SENSITIVE_SEGMENTS.test(command) || homeSecretPattern(home).test(command))) {
      return { rule: "sensitive-path", message: "Zugriff auf Zugangsdaten-Ordner (z. B. ~/.ssh) ist gesperrt." };
    }
    if (on("git-push-protected") && ctx.currentBranch && PROTECTED_BRANCHES.has(ctx.currentBranch) && new RegExp(String.raw`\bgit\b${SEP}\bpush\b`).test(command)) {
      return { rule: "git-push-protected", message: `Push vom geschützten Branch ${ctx.currentBranch} ist gesperrt.` };
    }
    return null;
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const raw of on("sensitive-path") ? pathFields(input) : []) {
      const abs = resolveToolPath(raw, ctx.projectDir, home);
      if (isSensitivePath(abs, home)) {
        return { rule: "sensitive-path", message: `Zugriff auf ${raw} ist gesperrt (Zugangsdaten/Browserprofil).` };
      }
    }
    if (on("sensitive-path") && SEARCH_TOOLS.has(toolName)) {
      const v = searchViolation(toolName, input, ctx, home);
      if (v) return v;
    }
    if (on("write-outside-project") && ctx.confineWritesToProject && writesOutsideProject(toolName, input, ctx.projectDir, home, ctx.extraWriteDirs)) {
      return { rule: "write-outside-project", message: "Im Autonomous-Profil sind Schreibzugriffe außerhalb des Projekts gesperrt." };
    }
  }
  return null;
}

/** True if the shell command's push needs the current branch (the only check that runs git). */
export function needsBranch(toolName: string, input: Record<string, unknown>): boolean {
  return SHELL_TOOLS.has(toolName) && typeof input.command === "string" && new RegExp(String.raw`\bgit\b${SEP}\bpush\b`).test(input.command);
}
