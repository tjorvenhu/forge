import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcessModule from "node:child_process";
import type { ClaudeSetupState } from "@forge/protocol";

/** No CLI is started: spawn() hands out fake children the test closes itself. */
const children = vi.hoisted(() => [] as FakeChild[]);

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  env: Record<string, string>;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
      const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, env: opts?.env ?? {} }) as FakeChild;
      children.push(c);
      return c;
    },
  };
});

vi.mock("../src/claude/environment.js", () => ({ locateClaude: () => "C:\\claude.exe", sessionEnv: () => ({}) }));

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../src/util/proc.js", () => ({ run: runMock }));

const { BROWSER_WAIT_MS, ClaudeSetupService } = await import("../src/claude/setup.js");

beforeEach(() => {
  children.length = 0;
});

describe("Claude setup", () => {
  it("ignores the late end of a cancelled login once the next one runs", () => {
    const states: ClaudeSetupState[] = [];
    const setup = new ClaudeSetupService((s) => states.push(s), () => ({ claudePath: null, stripApiKey: false }));
    setup.login();
    setup.cancel();
    expect(setup.current().phase).toBe("cancelled");
    setup.login();
    expect(children).toHaveLength(2);
    // The killed first child closes only now, with an error code.
    children[0]!.emit("close", 1);
    children[0]!.emit("error", new Error("killed"));
    expect(setup.current()).toMatchObject({ task: "login", phase: "running", message: null });
    // The new login still owns the process: a code goes to it, and its end counts.
    expect(() => setup.submitCode("abc")).not.toThrow();
    children[1]!.emit("close", 0);
    expect(setup.current()).toMatchObject({ phase: "done", message: "Angemeldet" });
  });

  it("does not let a cancelled install overwrite a login started after it", () => {
    const setup = new ClaudeSetupService(() => {}, () => ({ claudePath: null, stripApiKey: false }));
    setup.install();
    setup.cancel();
    setup.login();
    children[0]!.emit("close", 0);
    expect(setup.current()).toMatchObject({ task: "login", phase: "running" });
    expect(() => setup.install()).toThrow(/bereits/);
  });

  const AUTO = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A52494%2Fcallback&state=abc";
  const MANUAL = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc";
  const printed = `Opening browser to sign in…\nIf the browser didn't open, visit: ${MANUAL}\nPaste code here if prompted > `;

  it("opens the page that returns to the CLI on its own, like in a terminal", async () => {
    const setup = new ClaudeSetupService(() => {}, () => ({ claudePath: null, stripApiKey: false }));
    setup.login();
    const program = children[0]!.env.BROWSER!;
    expect(program).toMatch(/open\.cmd$/);
    expect(readFileSync(program, "utf8")).toContain("echo %*");
    // what the CLI does: BROWSER gets the page with the local callback, the output names the code page
    writeFileSync(path.join(path.dirname(program), "url.txt"), `"${AUTO}"\r\n`);
    children[0]!.stdout.write(printed);
    await vi.waitFor(() => expect(setup.current()).toMatchObject({ phase: "waiting_code", url: AUTO, codeUrl: MANUAL }));
    children[0]!.emit("close", 0);
    expect(setup.current()).toMatchObject({ phase: "done", url: null, codeUrl: null });
    // the helper is gone with the login
    expect(existsSync(program)).toBe(false);
  });

  it("falls back to the page with the code when the CLI does not call BROWSER", () => {
    vi.useFakeTimers();
    try {
      const setup = new ClaudeSetupService(() => {}, () => ({ claudePath: null, stripApiKey: false }));
      setup.login();
      children[0]!.stdout.emit("data", Buffer.from(printed));
      expect(setup.current()).toMatchObject({ phase: "running", url: null });
      vi.advanceTimersByTime(BROWSER_WAIT_MS);
      expect(setup.current()).toMatchObject({ phase: "waiting_code", url: MANUAL, codeUrl: null });
      children[0]!.emit("close", 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs out through the CLI and forgets the finished login of the old account", async () => {
    runMock.mockResolvedValue({ code: 0, stdout: "Successfully logged out", stderr: "", timedOut: false, spawnError: null });
    const states: ClaudeSetupState[] = [];
    const setup = new ClaudeSetupService((s) => states.push(s), () => ({ claudePath: null, stripApiKey: false }));
    setup.login();
    children[0]!.emit("close", 0);
    expect(setup.current().phase).toBe("done");
    await setup.logout();
    expect(runMock).toHaveBeenCalledWith("C:\\claude.exe", ["auth", "logout"], expect.anything());
    expect(setup.current()).toMatchObject({ task: null, phase: "idle" });
    expect(states.at(-1)).toMatchObject({ task: null, phase: "idle" });
  });

  it("does not sign out while a login runs and reports a failing logout", async () => {
    const setup = new ClaudeSetupService(() => {}, () => ({ claudePath: null, stripApiKey: false }));
    setup.login();
    await expect(setup.logout()).rejects.toThrow(/bereits/);
    children[0]!.emit("close", 0);
    runMock.mockResolvedValue({ code: 1, stdout: "", stderr: "keychain locked", timedOut: false, spawnError: null });
    await expect(setup.logout()).rejects.toThrow("Abmelden fehlgeschlagen: keychain locked");
    expect(setup.current().phase).toBe("done");
  });
});
