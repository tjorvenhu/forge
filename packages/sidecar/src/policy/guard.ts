import os from "node:os";
import path from "node:path";
import type { PolicyRuleId } from "@forge/protocol";
import { tr } from "../i18n/index.js";
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
  /** defaults to process.platform; decides which shell forms of home and root folders count */
  platform?: NodeJS.Platform;
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
// git.exe is found case-insensitively on Windows, so `Git push` is the same command.
const GIT = String.raw`\bgit\b`;
const GIT_PUSH = String.raw`${GIT}${SEP}\bpush\b${SEP}`;
const ANY_PUSH = new RegExp(String.raw`${GIT}${SEP}\bpush\b`, "i");

/**
 * `--name` or any abbreviation of it: git accepts unique prefixes of long options (`--forc`, `--del`).
 * Prefixes that are ambiguous for git fail there anyway, so matching them costs nothing.
 */
function longOption(name: string): string {
  const prefixes = Array.from({ length: name.length }, (_, i) => name.slice(0, name.length - i));
  return String.raw`(?<![\w-])--(?:${prefixes.join("|")})(?![\w-])`;
}

const GIT_RULES: Array<{ rule: PolicyRuleId; re: RegExp; message: () => string }> = [
  {
    rule: "git-force-push",
    re: new RegExp(String.raw`${GIT_PUSH}(${longOption("force")}|${longOption("force-with-lease")}|\s-[a-z]*f[a-z]*\b|\s["']?\+[^\s]+)`, "i"),
    message: () => tr().system.policy.gitForcePush,
  },
  {
    rule: "git-push-mirror",
    // --mirror and --prune delete remote refs that do not exist locally.
    re: new RegExp(String.raw`${GIT_PUSH}(${longOption("mirror")}|${longOption("prune")})`, "i"),
    message: () => tr().system.policy.gitPushMirror,
  },
  {
    rule: "git-push-protected",
    re: new RegExp(String.raw`${GIT_PUSH}(?:\s|:)["']?(?:refs/heads/)?(main|master)["']?(?=$|[\s;&|])`, "i"),
    message: () => tr().system.policy.gitPushProtected,
  },
  {
    rule: "git-push-delete",
    re: new RegExp(String.raw`${GIT_PUSH}(${longOption("delete")}|\s-[a-z]*d[a-z]*\b|\s["']?:[^\s]+)`, "i"),
    message: () => tr().system.policy.gitPushDelete,
  },
  {
    rule: "git-reset-hard",
    re: new RegExp(String.raw`${GIT}${SEP}\breset\b${SEP}${longOption("hard")}`, "i"),
    message: () => tr().system.policy.gitResetHard,
  },
  {
    rule: "git-branch-delete",
    re: new RegExp(String.raw`${GIT}${SEP}\bbranch\b${SEP}(\s-[a-z]*d[a-z]*\b|${longOption("delete")})`, "i"),
    message: () => tr().system.policy.gitBranchDelete,
  },
  {
    rule: "git-clean-force",
    re: new RegExp(String.raw`${GIT}${SEP}\bclean\b${SEP}(\s-[a-z]*f|${longOption("force")})`, "i"),
    message: () => tr().system.policy.gitCleanForce,
  },
];

const FORMAT_DISK = /\b(format(\.com)?\s+[A-Za-z]:|mkfs(\.\w+)?\s|Format-Volume\b|diskpart\b)/i;

const UNIX_DELETE = new Set(["rm"]);
const WIN_DELETE = new Set(["remove-item", "ri", "rd", "rmdir", "del", "erase"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_SEP = String.raw`[\\/]+`;

/**
 * The home folder as a shell writes it: variables of cmd, PowerShell and Bash, the literal path in
 * either slash style and its Git Bash, WSL and Cygwin forms. Other users' folders count as well, on
 * macOS and Linux also those below /Users and /home.
 */
function homeSource(home: string, platform: NodeJS.Platform = process.platform): string {
  const forms = [
    String.raw`~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|\$env:(?:USERPROFILE|HOME)|\$\{env:(?:USERPROFILE|HOME)\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%`,
    String.raw`[A-Za-z]:${ANY_SEP}Users${ANY_SEP}[^\\/\s"']+`,
    String.raw`(?:/mnt|/cygdrive)?/[A-Za-z]/Users/[^\\/\s"']+`,
  ];
  if (platform !== "win32") forms.push(String.raw`/(?:Users|home)/[^\\/\s"']+`, "/root");
  const parts = home.split(/[\\/]+/).filter(Boolean);
  const drive = /^([A-Za-z]):$/.exec(parts[0] ?? "")?.[1];
  const rest = parts.slice(drive ? 1 : 0).map(escapeRe).join(ANY_SEP);
  if (drive) forms.push(`${drive}:${ANY_SEP}${rest}`, `(?:/mnt|/cygdrive)?/${drive}${ANY_SEP}${rest}`);
  else if (rest) forms.push(`${ANY_SEP}${rest}`);
  return forms.join("|");
}

/**
 * Filesystem root, a drive root or the home folder, as a shell argument after quotes are removed and a
 * trailing separator or wildcard is cut off: /, /*, ~, ~/, $HOME, ${HOME}, C:\, C:/*, /c/ (Git Bash),
 * /mnt/c, $env:USERPROFILE\*, C:\Users\name, /c/Users/name.
 */
function rootTargetPattern(home: string, platform: NodeJS.Platform = process.platform): RegExp {
  // A one-letter folder like /a is a Git Bash drive only on Windows; elsewhere /Users and /home hold every home.
  const local = platform === "win32" ? String.raw`\/[A-Za-z]` : String.raw`\/Users|\/home`;
  return new RegExp(
    String.raw`^(|${homeSource(home, platform)}|\$env:(HOMEDRIVE|SystemDrive)|%(HOMEDRIVE|SystemDrive)%|[A-Za-z]:|${local}|\/mnt\/[A-Za-z]|\/cygdrive\/[A-Za-z]|[A-Za-z]:${ANY_SEP}Users|(?:/mnt|/cygdrive)?/[A-Za-z]/Users)$`,
    "i",
  );
}

function isRootTarget(arg: string, root: RegExp): boolean {
  if (!arg) return false;
  const trimmed = arg.replace(/([\\/]+\.?)*([\\/]+\*(\.\*)?)?$/, "").replace(/[\\/]+$/, "");
  return root.test(trimmed);
}

/** Splits a command line into words per control-operator segment; quotes are removed, not interpreted. */
function shellSegments(command: string): string[][] {
  return command
    .split(/[;&|\n()`]/)
    .map((seg) => (seg.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map((w) => w.replace(/["']/g, "")))
    .filter((words) => words.length > 0);
}

/** Like shellSegments, but a quoted string stays one word and control operators inside it do not split. */
function quotedSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote = "";
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = "";
      else word = (word ?? "") + ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/[;&|\n()`]/.test(ch)) endSegment();
    else if (/\s/.test(ch)) endWord();
    else word = (word ?? "") + ch;
  }
  endSegment();
  return segments;
}

const programName = (word: string) => (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

/** Programs that run their arguments as a command line of their own. */
const WRAPPERS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "dash", "ksh", "wsl", "eval", "iex", "invoke-expression"]);

/** PowerShell's -EncodedCommand and the abbreviations it accepts (-e, -ec, -enc, ...). */
function isEncodedFlag(word: string): boolean {
  const name = /^(?:--?|\/)([a-z]+)$/i.exec(word)?.[1]?.toLowerCase() ?? "";
  return name === "e" || name === "ec" || (name.length >= 2 && "encodedcommand".startsWith(name));
}

/**
 * Command lines a wrapper runs: `cmd /c "..."`, `bash -c '...'`, `powershell -Command ...` and the
 * base64 (UTF-16LE) of `-EncodedCommand`. The rest of the segment after the first wrapper is taken as
 * one command line; the switches in front of the payload (`/c`, `-c`) match no rule.
 */
function wrappedCommands(command: string): string[] {
  const out: string[] = [];
  for (const words of quotedSegments(command)) {
    const i = words.findIndex((w) => WRAPPERS.has(programName(w)));
    if (i === -1) continue;
    const rest = words.slice(i + 1);
    out.push(rest.join(" "));
    rest.forEach((w, j) => {
      const next = rest[j + 1];
      if (next && isEncodedFlag(w)) out.push(Buffer.from(next, "base64").toString("utf16le"));
    });
  }
  return out;
}

/** Wrappers nest rarely more than twice; the limit keeps a crafted command from recursing forever. */
const MAX_NESTING = 6;

/** The command line and every command line nested in it through wrappers. */
function commandLines(command: string, depth = 0): string[] {
  if (depth >= MAX_NESTING) return [command];
  return [command, ...wrappedCommands(command).flatMap((c) => commandLines(c, depth + 1))];
}

/** First recursive delete of a root/home target in the command: "unix", "win" or null. */
function rootDelete(command: string, root: RegExp): "unix" | "win" | null {
  for (const words of shellSegments(command)) {
    for (let i = 0; i < words.length; i++) {
      const name = programName(words[i]!);
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
      if ((recursive || !unix) && targets.some((t) => isRootTarget(t, root))) return unix ? "unix" : "win";
    }
  }
  return null;
}

const SENSITIVE_SEGMENTS =
  /(^|[\\/\s"'=~])(\.ssh|\.aws|\.gnupg|\.git-credentials|\.kube|\.credentials\.json)([\\/\s"']|$)|gh[\\/]hosts\.yml|GitHub CLI[\\/]hosts|(Chrome|Edge|Chromium|BraveSoftware)[\\/].*User Data|Firefox[\\/]Profiles|Microsoft[\\/](Credentials|Protect)/i;

/** Credential files that are only sensitive in the home folder (a project's own .npmrc is fine). */
const HOME_SECRET_FILE = String.raw`[\\/]+(\.npmrc|\.netrc|\.pgpass|\.docker[\\/]+config\.json|\.config[\\/]+gh)(?=[\\/\s"']|$)`;

function homeSecretPattern(home: string, platform: NodeJS.Platform = process.platform): RegExp {
  return new RegExp(String.raw`(${homeSource(home, platform)})["']?${HOME_SECRET_FILE}`, "i");
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
    message: tr().system.policy.searchBlocked(what),
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
function shellViolation(command: string, ctx: GuardContext, home: string, on: (rule: PolicyRuleId) => boolean): GuardViolation | null {
  const root = rootTargetPattern(home, ctx.platform);
  const secret = homeSecretPattern(home, ctx.platform);
  for (const line of commandLines(command)) {
    for (const r of GIT_RULES) {
      if (on(r.rule) && r.re.test(line)) return { rule: r.rule, message: r.message() };
    }
    const del = on("rm-root") ? rootDelete(line, root) : null;
    if (del === "unix") return { rule: "rm-root", message: tr().system.policy.rmRoot };
    if (del === "win") return { rule: "rm-root-win", message: tr().system.policy.rmRootWin };
    if (on("format-disk") && FORMAT_DISK.test(line)) return { rule: "format-disk", message: tr().system.policy.formatDisk };
    if (on("sensitive-path") && (SENSITIVE_SEGMENTS.test(line) || secret.test(line))) {
      return { rule: "sensitive-path", message: tr().system.policy.sensitivePath };
    }
    if (on("git-push-protected") && ctx.currentBranch && PROTECTED_BRANCHES.has(ctx.currentBranch) && ANY_PUSH.test(line)) {
      return { rule: "git-push-protected", message: tr().system.policy.pushFromProtected(ctx.currentBranch) };
    }
  }
  return null;
}

/** The shell command of a tool call. Not only Bash and PowerShell run one: Monitor does too, and so may tools added later. */
function shellCommand(toolName: string, input: Record<string, unknown>): string | null {
  if (typeof input.command === "string") return input.command;
  return SHELL_TOOLS.has(toolName) ? "" : null;
}

export function checkToolUse(toolName: string, input: Record<string, unknown>, ctx: GuardContext): GuardViolation | null {
  const home = ctx.home ?? os.homedir();
  const on = (rule: PolicyRuleId) => !ctx.disabledRules?.has(rule);
  const command = shellCommand(toolName, input);
  if (command !== null) {
    const v = shellViolation(command, ctx, home, on);
    if (v || SHELL_TOOLS.has(toolName)) return v;
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const raw of on("sensitive-path") ? pathFields(input) : []) {
      const abs = resolveToolPath(raw, ctx.projectDir, home);
      if (isSensitivePath(abs, home)) {
        return { rule: "sensitive-path", message: tr().system.policy.sensitiveNamed(raw) };
      }
    }
    if (on("sensitive-path") && SEARCH_TOOLS.has(toolName)) {
      const v = searchViolation(toolName, input, ctx, home);
      if (v) return v;
    }
    if (on("write-outside-project") && ctx.confineWritesToProject && writesOutsideProject(toolName, input, ctx.projectDir, home, ctx.extraWriteDirs)) {
      return { rule: "write-outside-project", message: tr().system.policy.writeOutside };
    }
  }
  return null;
}

/** True if the shell command's push needs the current branch (the only check that runs git). */
export function needsBranch(toolName: string, input: Record<string, unknown>): boolean {
  const command = shellCommand(toolName, input);
  return !!command && commandLines(command).some((line) => ANY_PUSH.test(line));
}
