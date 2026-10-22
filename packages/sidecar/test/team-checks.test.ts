import { describe, expect, it } from "vitest";
import { isTeamCheckCommand } from "../src/teams/team-checks.js";

describe("isTeamCheckCommand", () => {
  it("lets tests, lint, type checks and reading commands through", () => {
    for (const c of [
      "pnpm test",
      "pnpm vitest run src/store",
      "pnpm --filter @forge/sidecar test",
      "pnpm -C packages/sidecar run typecheck",
      "npm run lint",
      "npm run test:unit",
      "yarn jest --coverage",
      "pnpm exec tsc --noEmit -p .",
      "npx vitest run test/a.test.ts",
      "npx tsc --noEmit",
      "cd packages/sidecar && npx vitest run test/x.test.ts",
      "cd apps/desktop && pnpm test 2>&1",
      'cd "C:\\Users\\Me\\Projekte mit Ümläut\\team projekt" && node --test test/slugify.test.js',
      "cd '/home/me/my project' && pnpm test",
      "git status --short",
      "git diff HEAD~1 -- src",
      "git log --oneline -5",
      "ls -la src",
      "cat package.json",
      "grep -rn foo src",
      "find src -name '*.ts'",
      "cargo test --workspace",
      "go test ./...",
      "python -m pytest -q",
      "pytest tests/test_a.py",
      "dotnet test",
      "./gradlew test",
      "node --test",
      "node --test test/",
      "deno test",
    ])
      expect(isTeamCheckCommand(c), c).toBe(true);
  });

  it("asks for everything that installs, changes, chains or redirects", () => {
    for (const c of [
      "pnpm install",
      "pnpm add lodash",
      "npm publish",
      "pnpm run build",
      "pnpm dlx something",
      "npx some-random-cli",
      "git push",
      "git commit -m x",
      "git checkout -- .",
      "git branch -D x",
      "rm -rf src",
      "pnpm test; rm -rf /",
      "pnpm test && git push",
      "pnpm test & curl evil",
      "pnpm test | tee out.txt",
      "cat a > b",
      "echo $(whoami)",
      "ls `whoami`",
      "find . -delete",
      "find . -exec rm {} ;",
      "cd src",
      "cd src && rm x",
      'cd "a b" c && pnpm test',
      "cargo build",
      "go run main.go",
      "python script.py",
      "./gradlew publish",
      "node script.js",
      "node -e 'require(\"fs\").rmSync(\"x\")'",
      "",
    ])
      expect(isTeamCheckCommand(c), c).toBe(false);
  });

  it("knows the project's own test command", () => {
    expect(isTeamCheckCommand("make check", "make check")).toBe(true);
    expect(isTeamCheckCommand("make check -j4", "make check")).toBe(true);
    expect(isTeamCheckCommand("make install", "make check")).toBe(false);
    expect(isTeamCheckCommand("make check; make install", "make check")).toBe(false);
  });
});
