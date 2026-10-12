import { describe, expect, it } from "vitest";
import { parseBranches, parseLog, parseStatusV2, parseUnifiedDiff, scopeToPrefix, untrackedDiff } from "../src/git/parsers.js";
import { isArtifactPath, isSensitiveFile, repoNameFromUrl, validateCloneUrl } from "../src/git/git.js";

describe("parseStatusV2", () => {
  it("parses branch headers, modified, renamed, untracked, conflicted and paths with spaces/umlauts", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head feature/auth",
      "# branch.upstream origin/feature/auth",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/app/page.tsx",
      "1 A. N... 000000 100644 100644 000 ccc src/neue Datei mit Ümlaut.ts",
      "2 R. N... 100644 100644 100644 ddd eee R100 src/new name.ts",
      "src/old name.ts",
      "u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.txt",
      "? notes/todo.md",
      "",
    ].join("\0");
    const s = parseStatusV2(out);
    expect(s).toMatchObject({ branch: "feature/auth", upstream: "origin/feature/auth", ahead: 2, behind: 1, detached: false });
    expect(s.files.map((f) => [f.path, f.kind, f.staged, f.unstaged])).toEqual([
      ["src/app/page.tsx", "modified", false, true],
      ["src/neue Datei mit Ümlaut.ts", "added", true, false],
      ["src/new name.ts", "renamed", true, false],
      ["conflict.txt", "conflicted", false, true],
      ["notes/todo.md", "untracked", false, true],
    ]);
    expect(s.files[2]?.origPath).toBe("src/old name.ts");
  });

  it("handles detached HEAD and fresh repos", () => {
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0").detached).toBe(true);
    const fresh = parseStatusV2("# branch.oid (initial)\0# branch.head main\0");
    expect(fresh).toMatchObject({ branch: "main", ahead: 0, behind: 0, files: [] });
  });

  it("scopes a repository status to a project subfolder", () => {
    const s = parseStatusV2(
      [
        "# branch.head main",
        "1 .M N... 100644 100644 100644 a b packages/web/src/page.tsx",
        "1 .M N... 100644 100644 100644 a b README.md",
        "2 R. N... 100644 100644 100644 a b R100 packages/web/moved.ts",
        "packages/api/moved.ts",
        "? Packages/Web/neu.ts",
        "",
      ].join("\0"),
    );
    const scoped = scopeToPrefix(s, "packages/web/");
    expect(scoped.branch).toBe("main");
    expect(scoped.files.map((f) => [f.path, f.origPath])).toEqual([
      ["src/page.tsx", null],
      ["moved.ts", "../api/moved.ts"],
    ]);
    expect(scopeToPrefix(s, "packages/web/", true).files.map((f) => f.path)).toContain("neu.ts");
    expect(scopeToPrefix(s, "")).toBe(s);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers lines and counts additions/deletions", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+line2 changed",
      "+line2b",
      " line3",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const d = parseUnifiedDiff("a.ts", diff);
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.binary).toBe(false);
    expect(d.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["hunk", null, null],
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["meta", null, null],
    ]);
  });

  it("strips CR from diffs of files with Windows line endings", () => {
    const d = parseUnifiedDiff("a.ts", "diff --git a/a.ts b/a.ts\r\n@@ -1,2 +1,2 @@\r\n eins\r\n-zwei\r\n+drei\r\n");
    expect(d.lines.filter((l) => l.kind !== "hunk").map((l) => [l.kind, l.text])).toEqual([
      ["context", "eins"],
      ["del", "zwei"],
      ["add", "drei"],
    ]);
  });

  it("detects binary diffs", () => {
    const d = parseUnifiedDiff("img.png", "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n");
    expect(d.binary).toBe(true);
  });

  it("builds an add-only diff for untracked text files and flags binaries", () => {
    const d = untrackedDiff("x.txt", Buffer.from("a\r\nb\n"));
    expect(d.additions).toBe(2);
    expect(d.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["a", "b"]);
    expect(untrackedDiff("x.bin", Buffer.from([1, 0, 2])).binary).toBe(true);
  });
});

describe("log and branches", () => {
  it("parses log records", () => {
    const out =
      "abc123\x1fabc\x1fJane\x1f2026-10-10T12:00:00+02:00\x1fdef456 fed789\x1fHEAD -> main, origin/main, tag: v1\x1ffeat: login\x1e\n" +
      "def456\x1fdef\x1fJoe\x1f2026-10-09T12:00:00+02:00\x1f\x1f\x1ffix: x\x1e\n";
    expect(parseLog(out)).toEqual([
      {
        hash: "abc123",
        shortHash: "abc",
        author: "Jane",
        date: "2026-10-10T12:00:00+02:00",
        subject: "feat: login",
        parents: ["def456", "fed789"],
        refs: ["HEAD -> main", "origin/main", "tag: v1"],
      },
      { hash: "def456", shortHash: "def", author: "Joe", date: "2026-10-09T12:00:00+02:00", subject: "fix: x", parents: [], refs: [] },
    ]);
  });

  it("parses branches", () => {
    expect(parseBranches("*\0main\0origin/main\n \0feature/x\0\n")).toEqual([
      { name: "main", current: true, upstream: "origin/main" },
      { name: "feature/x", current: false, upstream: null },
    ]);
  });
});

describe("commit guards and clone validation", () => {
  it("flags sensitive files but not examples", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    expect(isSensitiveFile("config/.env.production")).toBe(true);
    expect(isSensitiveFile("keys/server.pem")).toBe(true);
    expect(isSensitiveFile("home/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveFile(".env.example")).toBe(false);
    expect(isSensitiveFile("src/env.ts")).toBe(false);
  });

  it("flags build artifacts", () => {
    expect(isArtifactPath("node_modules/x/index.js")).toBe(true);
    expect(isArtifactPath("apps/web/.next/cache/a")).toBe(true);
    expect(isArtifactPath("src/build.ts")).toBe(false);
  });

  it("accepts only safe clone URLs", () => {
    expect(validateCloneUrl("https://github.com/vanturis/forge.git")).toBeNull();
    expect(validateCloneUrl("git@github.com:vanturis/forge.git")).toBeNull();
    expect(validateCloneUrl("ssh://git@host/repo.git")).toBeNull();
    expect(validateCloneUrl("--upload-pack=evil")).not.toBeNull();
    expect(validateCloneUrl("ext::sh -c touch% /tmp/pwned")).not.toBeNull();
    expect(validateCloneUrl("file:///etc")).not.toBeNull();
    expect(validateCloneUrl("http://insecure.example/repo")).not.toBeNull();
    expect(repoNameFromUrl("https://github.com/a/my-repo.git")).toBe("my-repo");
    expect(repoNameFromUrl("git@github.com:a/b")).toBe("b");
  });
});
