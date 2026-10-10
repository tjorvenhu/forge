import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { MethodName, ParamsOf, ResultOf, ServerEvent } from "@forge/protocol";

/** Talks to the built sidecar exactly like the desktop shell does: JSON lines over stdio. */
export class SidecarClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: ServerEvent[] = [];
  private listeners: Array<(e: ServerEvent) => void> = [];
  stderr = "";

  constructor(dataDir: string) {
    const entry = path.join(import.meta.dirname, "..", "..", "dist", "sidecar.mjs");
    this.proc = spawn(process.execPath, ["--no-warnings", entry], {
      env: { ...process.env, FORGE_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stderr.on("data", (d: Buffer) => (this.stderr += d.toString()));
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.result);
        else {
          const err = msg.error as { code: string; message: string };
          p?.reject(Object.assign(new Error(`${err.code}: ${err.message}`), { code: err.code }));
        }
      } else if (typeof msg.event === "string") {
        const ev = msg as unknown as ServerEvent;
        this.events.push(ev);
        for (const l of this.listeners) l(ev);
      }
    });
  }

  request<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  waitFor(pred: (e: ServerEvent) => boolean, timeoutMs = 120_000, label = "event"): Promise<ServerEvent> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}\n${this.stderr.slice(-2000)}`)), timeoutMs);
      const l = (e: ServerEvent) => {
        if (!pred(e)) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(e);
      };
      this.listeners.push(l);
    });
  }

  /** Waits for the next turn.result of a session that arrives after `afterIndex` events. */
  async waitTurn(sessionId: string, afterIndex: number, timeoutMs = 180_000) {
    const ev = await this.waitFor(
      (e) => this.events.indexOf(e) >= afterIndex && e.event === "session.event" && e.payload.sessionId === sessionId && e.payload.body.type === "turn.result",
      timeoutMs,
      "turn.result",
    );
    return ev.event === "session.event" ? ev.payload.body : null;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.stdin.end();
      setTimeout(() => this.proc.kill(), 5000);
    });
  }

  kill(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.kill("SIGKILL");
    });
  }
}
