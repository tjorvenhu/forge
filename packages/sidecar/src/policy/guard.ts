import path from "node:path";
import { isInside, sensitivePaths } from "../util/paths.js";

export interface GuardContext {
  projectDir: string;
  confineWritesToProject: boolean;
  /** current branch of the project, if known; used for push-to-protected checks */
  currentBranch: string | null;
  home?: string;
}

export interface GuardViolation {
  rule: string;
  message: string;
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell", "BashOutput"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const FILE_TOOLS = new Set([...WRITE_TOOLS, "Read", "Glob", "Grep", "LS"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// Segments are separated by shell control operators so one command can't hide behind another.
const SEP = String.raw`[^;&|\n]*`;

const SHELL_RULES: Array<{ rule: string; re: RegExp; message: string }> = [
  {
    rule: "git-force-push",
    re: new RegExp(String.raw`\bgit\b${SEP}\bpush\b${SEP}(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f\b|\s\+[^\s]+)`),
    message: "Force-Push ist in FORGE gesperrt.",
  },
  {
    rule: "git-push-protected",
    re: new RegExp(String.raw`\bgit\b${SEP}\bpush\b${SEP}(?:\s|:)(main|master)(?=$|[\s;&|])`),
    message: "Push auf main/master ist in FORGE gesperrt.",
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
  {
    rule: "rm-root",
    re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*("|')?(\/|~|\$HOME|\/\*|~\/\*?|[A-Za-z]:[\\/]?)("|')?(\s|$)/,
    message: "Rekursives Löschen von Wurzel- oder Home-Verzeichnis ist gesperrt.",
  },
  {
    rule: "rm-root-win",
    re: /\b(Remove-Item|rd|rmdir|del)\b[^;&|\n]*\s("|')?([A-Za-z]:[\\/]?|~|\$HOME|\$env:USERPROFILE)("|')?(\s|$)/i,
    message: "Löschen von Laufwerks- oder Home-Wurzel ist gesperrt.",
  },
  {
    rule: "format-disk",
    re: /\b(format(\.com)?\s+[A-Za-z]:|mkfs(\.\w+)?\s|Format-Volume\b|diskpart\b)/i,
    message: "Datenträger formatieren ist gesperrt.",
  },
];

const SENSITIVE_SEGMENTS =
  /(^|[\\/\s"'=~])(\.ssh|\.aws|\.gnupg|\.git-credentials|\.kube|\.credentials\.json)([\\/\s"']|$)|gh[\\/]hosts\.yml|GitHub CLI[\\/]hosts|(Chrome|Edge|Chromium|BraveSoftware)[\\/].*User Data|Firefox[\\/]Profiles|\.mozilla[\\/]firefox|Microsoft[\\/](Credentials|Protect)/i;

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

export function resolveToolPath(p: string, projectDir: string, home?: string): string {
  const expanded = p.startsWith("~") && home ? path.join(home, p.slice(1)) : p;
  return path.resolve(projectDir, expanded);
}

/** True if a file tool would write outside the project. */
export function writesOutsideProject(toolName: string, input: Record<string, unknown>, projectDir: string, home?: string): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false;
  return pathFields(input).some((p) => !isInside(resolveToolPath(p, projectDir, home), projectDir));
}

/**
 * Hard rules that apply to every profile, including bypassPermissions.
 * Returns the first violation or null.
 */
export function checkToolUse(toolName: string, input: Record<string, unknown>, ctx: GuardContext): GuardViolation | null {
  if (SHELL_TOOLS.has(toolName)) {
    const command = typeof input.command === "string" ? input.command : "";
    for (const r of SHELL_RULES) {
      if (r.re.test(command)) return { rule: r.rule, message: r.message };
    }
    if (SENSITIVE_SEGMENTS.test(command)) {
      return { rule: "sensitive-path", message: "Zugriff auf Zugangsdaten-Ordner (z. B. ~/.ssh) ist gesperrt." };
    }
    if (
      ctx.currentBranch &&
      PROTECTED_BRANCHES.has(ctx.currentBranch) &&
      new RegExp(String.raw`\bgit\b${SEP}\bpush\b`).test(command)
    ) {
      return { rule: "git-push-protected", message: `Push vom geschützten Branch ${ctx.currentBranch} ist gesperrt.` };
    }
    return null;
  }

  if (FILE_TOOLS.has(toolName)) {
    for (const raw of pathFields(input)) {
      const abs = resolveToolPath(raw, ctx.projectDir, ctx.home);
      if (isSensitivePath(abs, ctx.home)) {
        return { rule: "sensitive-path", message: `Zugriff auf ${raw} ist gesperrt (Zugangsdaten/Browserprofil).` };
      }
    }
    if (ctx.confineWritesToProject && writesOutsideProject(toolName, input, ctx.projectDir, ctx.home)) {
      return { rule: "write-outside-project", message: "Im Autonomous-Profil sind Schreibzugriffe außerhalb des Projekts gesperrt." };
    }
  }
  return null;
}
