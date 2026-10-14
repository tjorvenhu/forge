import { EventEmitter } from "node:events";
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
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: () => {
      const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as FakeChild;
      children.push(c);
      return c;
    },
  };
});

vi.mock("../src/claude/environment.js", () => ({ locateClaude: () => "C:\\claude.exe", sessionEnv: () => ({}) }));

const { ClaudeSetupService } = await import("../src/claude/setup.js");

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
});
