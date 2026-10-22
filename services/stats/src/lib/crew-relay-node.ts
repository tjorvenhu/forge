import http from "node:http";
import { RelayCore, STREAM_HEADERS, type RelayOptions } from "./crew-relay";

/**
 * The crew relay on a plain node:http server, with the same paths as the website (/crew/v1/...).
 * FORGE's sidecar tests run it in-process; it also serves a relay without Next if ever needed.
 */
export function createRelayServer(opts: RelayOptions = {}) {
  const core = new RelayCore(opts);

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > core.maxBodyBytes) {
          done = true;
          resolve(null);
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!done) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", () => {
        if (!done) resolve(null);
      });
    });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === "/crew/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }
    const m = /^\/crew\/v1\/rooms\/([^/]+)(\/stream)?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: "not found" });
    const room = decodeURIComponent(m[1]!);
    if (m[2] && req.method === "GET") {
      const reader = { write: (chunk: string) => void res.write(chunk), close: () => res.end() };
      res.writeHead(200, STREAM_HEADERS);
      const sub = core.subscribe(room, Number(url.searchParams.get("after") ?? 0), reader);
      if ("status" in sub) {
        res.end(`event: error\ndata: ${JSON.stringify(sub.body)}\n\n`);
        return;
      }
      req.on("close", sub.stop);
      res.on("error", sub.stop);
      return;
    }
    if (!m[2] && req.method === "POST") {
      void readBody(req).then((raw) => {
        const r = core.post(room, raw, req.socket.remoteAddress ?? "?");
        send(res, r.status, r.body);
      });
      return;
    }
    send(res, 405, { error: "method not allowed" });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    server,
    core,
    close: () =>
      new Promise<void>((resolve) => {
        core.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
