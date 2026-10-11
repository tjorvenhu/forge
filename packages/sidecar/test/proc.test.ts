import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/util/proc.js";
import { runUserCommand } from "../src/util/shell.js";
import { tempDir } from "./helpers.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

/** Starts a grandchild that inherits the pipes and prints its pid, then waits itself. */
const PARENT = [
  "const { spawn } = require('node:child_process');",
  "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
  "console.log('child=' + c.pid);",
  "setTimeout(() => {}, 60000);",
].join("\n");

/** Same, but the parent exits at once and leaves the grandchild holding the pipes. */
const LEAVER = [
  "const { spawn } = require('node:child_process');",
  "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true });",
  "c.unref();",
  "console.log('child=' + c.pid);",
].join("\n");

const childPid = (out: string) => Number(/child=(\d+)/.exec(out)?.[1]);

describe("process helpers", () => {
  it("kills the whole process tree on timeout and still resolves", async () => {
    const started = Date.now();
    const r = await run(process.execPath, ["-e", PARENT], { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = childPid(r.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(await waitDead(pid)).toBe(true);
  }, 20_000);

  it("resolves when the process exits although a leftover child keeps the pipes open", async () => {
    const started = Date.now();
    const r = await run(process.execPath, ["-e", LEAVER], { timeoutMs: 30_000 });
    const pid = childPid(r.stdout);
    try {
      expect(r).toMatchObject({ code: 0, timedOut: false });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      if (pid && alive(pid)) process.kill(pid);
    }
  }, 20_000);

  describe("user commands", () => {
    let t: ReturnType<typeof tempDir>;
    beforeEach(() => {
      t = tempDir("forge-proc-");
      mkdirSync(t.dir, { recursive: true });
    });
    afterEach(() => t.cleanup());

    const script = (name: string, code: string) => {
      const file = path.join(t.dir, name);
      writeFileSync(file, code);
      return `"${process.execPath}" "${file}"`;
    };
    const env = () => ({ ...process.env }) as Record<string, string>;

    it("ends the command with its children on timeout", async () => {
      const r = await runUserCommand(script("parent.cjs", PARENT), t.dir, env(), 1500);
      expect(r.timedOut).toBe(true);
      const pid = childPid(r.output);
      expect(pid).toBeGreaterThan(0);
      expect(await waitDead(pid)).toBe(true);
    }, 20_000);

    it("keeps multi-byte characters intact across chunks", async () => {
      const r = await runUserCommand(script("umlaut.cjs", "process.stdout.write('Gr\\u00fc\\u00dfe'.repeat(20000));"), t.dir, env());
      expect(r.output).not.toContain("�");
      expect(r.output.endsWith("Grüße")).toBe(true);
    }, 20_000);
  });
});
