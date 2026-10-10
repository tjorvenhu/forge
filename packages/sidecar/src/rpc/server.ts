import { ForgeError, methods, RpcRequest, type MethodName, type RpcResponse, type ServerEvent } from "@forge/protocol";
import type { Handlers } from "./handlers.js";

export type Writer = (line: string) => void;

export class RpcServer {
  constructor(
    private readonly handlers: Handlers,
    private readonly write: Writer,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  emit(e: ServerEvent) {
    this.write(JSON.stringify(e));
  }

  private respond(r: RpcResponse) {
    this.write(JSON.stringify(r));
  }

  async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.log("ungültiges JSON von der UI verworfen");
      return;
    }
    const req = RpcRequest.safeParse(raw);
    if (!req.success) {
      this.log("ungültige Anfrage verworfen");
      return;
    }
    const { id, method, params } = req.data;
    if (!Object.hasOwn(methods, method)) {
      this.respond({ id, ok: false, error: { code: "VALIDATION", message: `Unbekannte Methode: ${method}` } });
      return;
    }
    const name = method as MethodName;
    const parsed = methods[name].params.safeParse(params ?? {});
    if (!parsed.success) {
      this.respond({
        id,
        ok: false,
        error: { code: "VALIDATION", message: "Ungültige Parameter", details: parsed.error.issues },
      });
      return;
    }
    try {
      const handler = this.handlers[name] as (p: unknown) => unknown;
      const result = await handler(parsed.data);
      this.respond({ id, ok: true, result: result ?? null });
    } catch (e) {
      if (e instanceof ForgeError) {
        this.respond({ id, ok: false, error: e.toJSON() });
      } else {
        const message = e instanceof Error ? e.message : String(e);
        this.log(`Fehler in ${method}: ${message}`);
        this.respond({ id, ok: false, error: { code: "INTERNAL", message } });
      }
    }
  }
}
