import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { analyzeTurn, canonicalCommand, equivalentTestCommands, isTestRelevant, scopedTestCommand } from "../src/sessions/test-gate.js";

const cwd = path.resolve("/repo/shop");
let seq = 0;
const ev = (body: SessionEventBody): SessionEvent => ({ seq: ++seq, sessionId: "s", ts: "2026-10-17T10:00:00.000Z", body });

/** A tool call with its result, as the normalizer records it. */
function tool(name: string, input: Record<string, unknown>, result: { isError?: boolean; text?: string; truncated?: boolean } = {}, parent: string | null = null): SessionEvent[] {
  const id = `t${seq + 1}`;
  return [
    ev({ type: "tool.use", toolUseId: id, name, input, parentToolUseId: parent }),
    ev({ type: "tool.result", toolUseId: id, isError: result.isError ?? false, content: { text: result.text ?? "", truncated: result.truncated ?? false } }),
  ];
}
const edit = (file: string) => tool("Edit", { file_path: path.join(cwd, file), old_string: "a", new_string: "b" });
const bash = (command: string, result?: { isError?: boolean; text?: string; truncated?: boolean }) => tool("Bash", { command }, result);
const VITEST_OK = " Test Files  12 passed (12)\n      Tests  148 passed (148)\n   Duration  9.31s";
const VITEST_FAIL = " Test Files  1 failed | 11 passed (12)\n      Tests  2 failed | 146 passed (148)";

const forms = equivalentTestCommands("pnpm test", "pnpm -r test");

describe("test relevance of changed files", () => {
  it("leaves out docs, images, project knowledge and editor settings", () => {
    for (const f of ["README.md", "docs/setup.md", ".forge/knowledge/tempo.md", "public/logo.png", "assets/hero.JPG", "CHANGELOG", "LICENSE", ".vscode/settings.json", ".claude/settings.local.json"]) {
      expect(isTestRelevant(f), f).toBe(false);
    }
  });

  it("keeps code, config and docs or images used as test input", () => {
    for (const f of ["src/app.ts", "package.json", "pnpm-lock.yaml", "notes.txt", "page.mdx", "test/fixtures/sample.md", "src/__snapshots__/x.png", "e2e/screens/home.png", ".forge/config.json"]) {
      expect(isTestRelevant(f), f).toBe(true);
    }
  });
});

describe("equivalent test commands", () => {
  it("treats the package managers' test script calls and the root script as the same run", () => {
    for (const c of ["pnpm test", "npm test", "npm run test", "yarn test", "pnpm run test", "pnpm -r test", "pnpm --recursive run test", "CI=1 pnpm test", "pnpm test -- --run", "pnpm test 2>&1"]) {
      expect(forms.has(canonicalCommand(c)), c).toBe(true);
    }
  });

  it("does not count partial runs as the full suite", () => {
    for (const c of ["pnpm test src/a.test.ts", "pnpm --filter @shop/api test", "pnpm exec vitest run test/a.test.ts", "bun test", "pnpm typecheck"]) {
      expect(forms.has(canonicalCommand(c)), c).toBe(false);
    }
  });
});

describe("what a turn did", () => {
  it("sees that Claude ran the whole suite green after its last change", () => {
    const events = [...edit("src/cart.ts"), ...bash("pnpm exec vitest run test/cart.test.ts", { text: VITEST_OK }), ...bash("pnpm test", { text: VITEST_OK }), ...bash("git status")];
    expect(analyzeTurn(events, cwd, forms)).toMatchObject({ edited: ["src/cart.ts"], testedAfterLastChange: true, shellChanges: false });
  });

  it("needs the tests again after a code change that came after the run", () => {
    const events = [...edit("src/cart.ts"), ...bash("pnpm test", { text: VITEST_OK }), ...edit("src/cart.ts")];
    expect(analyzeTurn(events, cwd, forms).testedAfterLastChange).toBe(false);
  });

  it("keeps a green run when only docs changed afterwards, or a subagent only read files", () => {
    const events = [...edit("src/cart.ts"), ...bash("pnpm test", { text: VITEST_OK }), ...edit("README.md"), ...tool("Read", { file_path: path.join(cwd, "src/cart.ts") }, {}, "agent1")];
    expect(analyzeTurn(events, cwd, forms).testedAfterLastChange).toBe(true);
  });

  it("does not trust a failed run, nor a piped one whose output shows failures or no result", () => {
    expect(analyzeTurn([...edit("a.ts"), ...bash("pnpm test", { isError: true, text: VITEST_FAIL })], cwd, forms).testedAfterLastChange).toBe(false);
    // tail swallows the exit code: the output decides
    expect(analyzeTurn([...edit("a.ts"), ...bash("pnpm test 2>&1 | tail -20", { text: VITEST_FAIL })], cwd, forms).testedAfterLastChange).toBe(false);
    expect(analyzeTurn([...edit("a.ts"), ...bash("pnpm test | head -5", { text: "> shop@1.0.0 test" })], cwd, forms).testedAfterLastChange).toBe(false);
    expect(analyzeTurn([...edit("a.ts"), ...bash("pnpm test 2>&1 | tail -20", { text: VITEST_OK })], cwd, forms).testedAfterLastChange).toBe(true);
  });

  it("follows cd: the suite only counts when it ran in the project folder", () => {
    expect(analyzeTurn([...bash("cd packages/api && pnpm test", { text: VITEST_OK })], cwd, forms).testedAfterLastChange).toBe(false);
    // the shell stays in the package for the next command
    const later = analyzeTurn([...bash("cd packages/api"), ...bash("pnpm test", { text: VITEST_OK })], cwd, forms);
    expect(later.testedAfterLastChange).toBe(false);
    expect(later.shellDir).toBe(path.join(cwd, "packages/api"));
    expect(analyzeTurn([...bash(`cd "${cwd}" && pnpm test`, { text: VITEST_OK })], cwd, forms, path.join(cwd, "packages/api")).testedAfterLastChange).toBe(true);
  });

  it("counts shell commands that may write files as changes, read-only and check commands not", () => {
    for (const c of ["git status && git diff", "ls -la | grep x", "pnpm typecheck", "pnpm lint", "pnpm exec vitest run a.test.ts", "git add -A && git commit -m x", "sed -n 1,20p a.ts", "Get-Content a.ts | Select-Object -First 5"]) {
      expect(analyzeTurn(bash(c), cwd, forms).shellChanges, c).toBe(false);
    }
    for (const c of ["pnpm add zod", "sed -i s/a/b/ a.ts", "echo x > a.ts", "node scripts/gen.mjs", "pnpm lint --fix", "pnpm exec vitest run -u", "git checkout main", "git stash", "rm -rf src"]) {
      expect(analyzeTurn(bash(c), cwd, forms).shellChanges, c).toBe(true);
    }
  });

  it("ignores edits outside the project folder and runs started in the background", () => {
    const events = [...tool("Write", { file_path: path.resolve("/tmp/notes.ts"), content: "x" }), ...tool("Bash", { command: "pnpm test", run_in_background: true }, { text: "Command running in background with ID: b1" })];
    expect(analyzeTurn(events, cwd, forms)).toMatchObject({ edited: [], testedAfterLastChange: false });
  });
});

describe("tests limited to the changed packages", () => {
  const packages = new Set(["packages/api", "packages/ui", "apps/web"]);
  const isPackage = (d: string) => packages.has(d);

  it("filters a recursive pnpm run to the changed packages and their dependents", () => {
    expect(scopedTestCommand("pnpm test", "pnpm -r test", ["packages/api/src/a.ts", "packages/api/test/a.test.ts", "apps/web/src/page.tsx"], isPackage, true)).toBe(
      'pnpm -r --filter "...{./apps/web}" --filter "...{./packages/api}" test',
    );
    expect(scopedTestCommand("pnpm -r test", null, ["packages/ui/src/deep/x.ts"], isPackage, true)).toBe('pnpm -r --filter "...{./packages/ui}" test');
  });

  it("runs everything when a root file changed, outside a pnpm workspace or for another command", () => {
    expect(scopedTestCommand("pnpm test", "pnpm -r test", ["packages/api/a.ts", "tsconfig.base.json"], isPackage, true)).toBeNull();
    expect(scopedTestCommand("pnpm test", "pnpm -r test", ["packages/api/a.ts"], isPackage, false)).toBeNull();
    expect(scopedTestCommand("pnpm test", "vitest run", ["packages/api/a.ts"], isPackage, true)).toBeNull();
    expect(scopedTestCommand("pnpm test", "pnpm -r test && pnpm e2e", ["packages/api/a.ts"], isPackage, true)).toBeNull();
  });
});
