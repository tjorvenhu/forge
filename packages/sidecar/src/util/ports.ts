import net from "node:net";
import { tr } from "../i18n/index.js";

function listenable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * Whether nothing listens on the port on this machine. Both loopback addresses: dev servers bind
 * "localhost", which is ::1 on many Windows machines.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return (await listenable(port, "127.0.0.1")) && (await listenable(port, "::1"));
}

/** First free port from `from` on that is not in `skip` (ports promised to someone else). */
export async function findFreePort(from: number, skip: Iterable<number> = [], free: (port: number) => Promise<boolean> = isPortFree): Promise<number> {
  const taken = new Set(skip);
  for (let port = from; port <= 65535; port++) {
    if (!taken.has(port) && (await free(port))) return port;
  }
  throw new Error(tr().system.paths.noFreePort(from));
}
