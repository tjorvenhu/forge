import { posix } from "node:path";
import type { BranchInfo, CommitFile, CommitInfo, DiffLine, FileDiff, FileStatus, GitSummary } from "@forge/protocol";
import { avatarFromEmail } from "../github/avatars.js";
import { tr } from "../i18n/index.js";

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

function kindOf(x: string, y: string): FileStatus["kind"] {
  if (x === "R" || y === "R" || x === "C") return "renamed";
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "typechange";
  return "modified";
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): ParsedStatus {
  const res: ParsedStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (!f) continue;
    if (f.startsWith("# ")) {
      const [, key, ...rest] = f.split(" ");
      const val = rest.join(" ");
      if (key === "branch.head") {
        if (val === "(detached)") res.detached = true;
        else res.branch = val;
      } else if (key === "branch.upstream") res.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          res.ahead = Number(m[1]);
          res.behind = Number(m[2]);
        }
      }
      continue;
    }
    const type = f[0];
    if (type === "1") {
      // 1 XY sub mH mI mW hH hI path
      const parts = f.split(" ");
      const xy = parts[1]!;
      const p = parts.slice(8).join(" ");
      res.files.push(entry(p, null, xy[0]!, xy[1]!));
    } else if (type === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = f.split(" ");
      const xy = parts[1]!;
      const p = parts.slice(9).join(" ");
      const orig = fields[++i] ?? null;
      res.files.push(entry(p, orig, xy[0]!, xy[1]!));
    } else if (type === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = f.split(" ");
      const xy = parts[1]!;
      const p = parts.slice(10).join(" ");
      res.files.push({
        path: p,
        origPath: null,
        index: xy[0]!,
        worktree: xy[1]!,
        kind: "conflicted",
        staged: false,
        unstaged: true,
      });
    } else if (type === "?") {
      // A trailing slash even with -uall: another repository inside this one (an agent's worktree
      // under .claude/worktrees, a cloned dependency). Not a file to diff or commit; `git add`
      // would only embed it as a broken gitlink.
      if (f.endsWith("/")) continue;
      res.files.push({
        path: f.slice(2),
        origPath: null,
        index: "?",
        worktree: "?",
        kind: "untracked",
        staged: false,
        unstaged: true,
      });
    }
  }
  return res;
}

/**
 * Restricts a status (paths relative to the repository root) to the files below `prefix`
 * (`git rev-parse --show-prefix`, e.g. "packages/web/") and makes their paths relative to it.
 * A rename source outside the folder becomes a "../" path, which git still accepts as pathspec.
 */
export function scopeToPrefix(s: ParsedStatus, prefix: string, ignoreCase = false): ParsedStatus {
  if (!prefix) return s;
  const norm = (p: string) => (ignoreCase ? p.toLowerCase() : p);
  const pre = norm(prefix);
  const files = s.files
    .filter((f) => norm(f.path).startsWith(pre))
    .map((f) => {
      let origPath = f.origPath;
      if (origPath !== null) {
        origPath = norm(origPath).startsWith(pre) ? origPath.slice(prefix.length) : posix.relative(prefix, origPath);
      }
      return { ...f, path: f.path.slice(prefix.length), origPath };
    });
  return { ...s, files };
}

function entry(p: string, orig: string | null, x: string, y: string): FileStatus {
  return {
    path: p,
    origPath: orig,
    index: x,
    worktree: y,
    kind: kindOf(x, y),
    staged: x !== ".",
    unstaged: y !== ".",
  };
}

export function summarize(s: ParsedStatus, remoteUrl: string | null): GitSummary {
  return {
    isRepo: true,
    branch: s.branch,
    detached: s.detached,
    ahead: s.ahead,
    behind: s.behind,
    upstream: s.upstream,
    changedCount: s.files.length,
    conflicted: s.files.some((f) => f.kind === "conflicted"),
    remoteUrl,
  };
}

const MAX_DIFF_LINES = 5000;

/** Parses unified diff output for a single file. */
export function parseUnifiedDiff(path: string, text: string): FileDiff {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let truncated = false;
  let inHunk = false;
  const raw = text.split(/\r?\n/);
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  for (const l of raw) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: l, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      if (/^Binary files .* differ$/.test(l) || l.startsWith("GIT binary patch")) binary = true;
      if (l.startsWith("diff --git") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ")) continue;
      lines.push({ kind: "meta", text: l, oldNo: null, newNo: null });
      continue;
    }
    const c = l[0];
    if (c === "+") {
      additions++;
      lines.push({ kind: "add", text: l.slice(1), oldNo: null, newNo: newNo++ });
    } else if (c === "-") {
      deletions++;
      lines.push({ kind: "del", text: l.slice(1), oldNo: oldNo++, newNo: null });
    } else if (c === " " || l === "") {
      lines.push({ kind: "context", text: l.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === "\\") {
      lines.push({ kind: "meta", text: l, oldNo: null, newNo: null });
    } else if (l.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return { path, binary, additions, deletions, lines, truncated };
}

/** Builds an all-added diff for an untracked file. */
export function untrackedDiff(path: string, content: Buffer): FileDiff {
  const head = content.subarray(0, 8000);
  if (head.includes(0)) {
    return { path, binary: true, additions: 0, deletions: 0, lines: [], truncated: false };
  }
  const text = content.toString("utf8");
  const raw = text.split(/\r?\n/);
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  const truncated = raw.length > MAX_DIFF_LINES;
  const shown = raw.slice(0, MAX_DIFF_LINES);
  const lines: DiffLine[] = [
    { kind: "meta", text: tr().system.git.newUntrackedFile, oldNo: null, newNo: null },
    ...shown.map((t, i) => ({ kind: "add" as const, text: t, oldNo: null, newNo: i + 1 })),
  ];
  return { path, binary: false, additions: raw.length, deletions: 0, lines, truncated };
}

// The subject comes last: it is the only field that may contain anything.
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1f%s%x1e";

export function parseLog(out: string): CommitInfo[] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash = "", shortHash = "", author = "", authorEmail = "", date = "", parents = "", refs = "", ...subject] = r.split("\x1f");
      return {
        hash,
        shortHash,
        author,
        authorEmail,
        avatarUrl: avatarFromEmail(authorEmail),
        date,
        subject: subject.join("\x1f"),
        parents: parents.split(" ").filter(Boolean),
        refs: refs.split(", ").filter(Boolean),
      };
    });
}

const COMMIT_KIND: Record<string, CommitFile["kind"]> = { A: "added", C: "added", D: "deleted", R: "renamed", T: "typechange" };

/** Joins `git diff --name-status -z` and `git diff --numstat -z` of the same range into one list. */
export function parseCommitFiles(nameStatus: string, numstat: string): CommitFile[] {
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const nt = numstat.split("\0");
  for (let i = 0; i < nt.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nt[i]!);
    if (!m) continue;
    // A rename has an empty path here, followed by the old and the new path.
    let p = m[3]!;
    if (!p) {
      p = nt[i + 2] ?? "";
      i += 2;
    }
    const binary = m[1] === "-";
    counts.set(p, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }

  const files: CommitFile[] = [];
  const st = nameStatus.split("\0");
  for (let i = 0; i < st.length; i++) {
    const code = st[i]!;
    if (!code) continue;
    const letter = code[0]!;
    const twoPaths = letter === "R" || letter === "C";
    const origPath = twoPaths ? (st[i + 1] ?? null) : null;
    const p = st[i + (twoPaths ? 2 : 1)] ?? "";
    i += twoPaths ? 2 : 1;
    if (!p) continue;
    const c = counts.get(p) ?? { additions: 0, deletions: 0, binary: false };
    files.push({ path: p, origPath, kind: COMMIT_KIND[letter] ?? "modified", ...c });
  }
  return files;
}

/** Parses `git branch --format=%(HEAD)%00%(refname:short)%00%(upstream:short)`. */
export function parseBranches(out: string): BranchInfo[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [head = "", name = "", upstream = ""] = l.split("\0");
      return { name, current: head === "*", upstream: upstream || null };
    })
    .filter((b) => b.name && !b.name.startsWith("("));
}
