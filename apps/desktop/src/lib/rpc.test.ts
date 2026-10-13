import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;

const handlers = new Map<string, Handler[]>();
const sent: Array<{ id: string; method: string }> = [];
let sidecarRunning = true;
const invokeMock = vi.fn(async (cmd: string, args?: { line?: string }) => {
  if (cmd === "sidecar_status") return sidecarRunning;
  if (cmd === "sidecar_send") sent.push(JSON.parse(args!.line!) as { id: string; method: string });
  return undefined;
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: { line?: string }) => invokeMock(cmd, args) }));
// Like the shell: every window listens, every window gets every line.
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, h: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), h]);
    return () => {};
  },
}));

const { RpcClient, requestIdPrefix } = await import("./rpc");

const broadcast = (line: object) => handlers.get("sidecar://messages")?.forEach((h) => h({ payload: [JSON.stringify(line)] }));

beforeEach(() => {
  handlers.clear();
  sent.length = 0;
  sidecarRunning = true;
  invokeMock.mockClear();
});

describe("request ids across windows", () => {
  it("uses a random prefix per client that fits the protocol's id limit", () => {
    const a = requestIdPrefix();
    const b = requestIdPrefix();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("resolves a call only in the window that made it", async () => {
    const main = new RpcClient();
    const chat = new RpcClient();
    await main.start();
    await chat.start({ manageSidecar: false });

    const fromMain = main.call("settings.get", {} as never);
    const fromChat = chat.call("settings.get", {} as never);
    const [mainReq, chatReq] = sent;
    expect(mainReq!.id).not.toBe(chatReq!.id);
    expect(mainReq!.id.length).toBeLessThanOrEqual(64);

    broadcast({ id: chatReq!.id, ok: true, result: "chat" });
    broadcast({ id: mainReq!.id, ok: true, result: "main" });
    await expect(fromMain).resolves.toBe("main");
    await expect(fromChat).resolves.toBe("chat");
  });

  it("delivers push events to every window", async () => {
    const main = new RpcClient();
    const chat = new RpcClient();
    await main.start();
    await chat.start({ manageSidecar: false });
    const seen: string[] = [];
    main.subscribe(() => seen.push("main"));
    chat.subscribe(() => seen.push("chat"));
    broadcast({ event: "session.updated", payload: {} });
    expect(seen.sort()).toEqual(["chat", "main"]);
  });
});

describe("sidecar start", () => {
  it("restarts a stopped sidecar from the main window only", async () => {
    sidecarRunning = false;
    const chat = new RpcClient();
    const states: boolean[] = [];
    chat.onStatus((up) => states.push(up));
    await chat.start({ manageSidecar: false });
    expect(invokeMock).not.toHaveBeenCalledWith("sidecar_restart", undefined);
    expect(states).toEqual([false]);

    // The main window restarts it; the ready event brings the chat window up.
    broadcast({ event: "sidecar.ready", payload: {} });
    expect(states).toEqual([false, true]);

    const main = new RpcClient();
    await main.start();
    expect(invokeMock).toHaveBeenCalledWith("sidecar_restart", undefined);
  });
});
