import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ErrorCode, MethodName, ParamsOf, ResultOf, RpcError, ServerEvent } from "@forge/protocol";

export class RpcCallError extends Error {
  constructor(
    public readonly code: ErrorCode | "SIDECAR_DOWN",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Listener = (e: ServerEvent) => void;

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LONG_METHODS = new Set<MethodName>(["projects.clone", "system.diagnostics", "system.runtimeInfo"]);

class RpcClient {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(up: boolean, detail?: string) => void>();
  private started = false;
  up = false;

  async start() {
    if (this.started) return;
    this.started = true;
    await listen<string>("sidecar://message", (e) => this.onLine(e.payload));
    await listen<{ code: number | null; stderr: string }>("sidecar://exit", (e) => {
      this.setUp(false, e.payload.stderr);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcCallError("SIDECAR_DOWN", "Der FORGE-Hintergrunddienst wurde beendet."));
      }
      this.pending.clear();
    });
    const running = await invoke<boolean>("sidecar_status");
    if (running) this.setUp(true);
    else await this.restart();
  }

  async restart() {
    await invoke("sidecar_restart");
  }

  private setUp(up: boolean, detail?: string) {
    this.up = up;
    for (const l of this.statusListeners) l(up, detail);
  }

  onStatus(l: (up: boolean, detail?: string) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }

  private onLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result);
      else {
        const err = msg.error as RpcError;
        p.reject(new RpcCallError(err.code, err.message, err.details));
      }
      return;
    }
    if (typeof msg.event === "string") {
      const ev = msg as unknown as ServerEvent;
      if (ev.event === "sidecar.ready") this.setUp(true);
      for (const l of this.listeners) l(ev);
    }
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = String(this.nextId++);
    const timeoutMs = LONG_METHODS.has(method) ? 20 * 60_000 : 120_000;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcCallError("INTERNAL", `Zeitüberschreitung bei ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      invoke("sidecar_send", { line: JSON.stringify({ id, method, params }) }).catch((e: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcCallError("SIDECAR_DOWN", String(e)));
      });
    });
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}

export const rpc = new RpcClient();

export function errorMessage(e: unknown): string {
  if (e instanceof RpcCallError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
