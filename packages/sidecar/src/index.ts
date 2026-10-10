import { createInterface } from "node:readline";
import { createApp } from "./app.js";
import { dataDir } from "./util/paths.js";

const VERSION = "0.1.0";

// stdout carries the protocol exclusively; everything else goes to stderr.
const write = (line: string) => {
  process.stdout.write(line + "\n");
};
const log = (msg: string) => {
  process.stderr.write(`[forge-sidecar] ${msg}\n`);
};

const app = createApp({ dataDir: dataDir(), write, log });

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    app.shutdown();
  } finally {
    process.exit(code);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void app.server.handleLine(line);
});
// The desktop shell closing stdin means the app is gone: clean up child processes.
rl.on("close", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (e) => {
  log(`uncaughtException: ${e.stack ?? e.message}`);
});
process.on("unhandledRejection", (e) => {
  log(`unhandledRejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
});

app.server.emit({ event: "sidecar.ready", payload: { version: VERSION } });
log(`bereit (Node ${process.version})`);
