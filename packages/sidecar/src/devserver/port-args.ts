import { readFile } from "node:fs/promises";
import path from "node:path";

/** Dev servers that take `--port`; they ignore the PORT variable or prefer their config file over it. */
const PORT_FLAG = /^(?:vite(?:\s+(?:dev|serve))?|next\s+dev|astro\s+dev|nuxi?\s+dev|ng\s+serve|webpack\s+serve|webpack-dev-server|vue-cli-service\s+serve|gatsby\s+develop|storybook\s+dev|docusaurus\s+start|react-router\s+dev|remix\s+vite:dev|svelte-kit\s+dev)(?:\s|$)/;
/** Several commands in one: an appended flag would only reach the last of them. */
const CHAIN = /&&|\|\||[;|&<>]/;
const SCRIPT_CALL = /^(pnpm|yarn|npm|bun)(\s+run)?\s+([\w:.-]+)$/;

function takesPortFlag(command: string): boolean {
  const c = command.trim();
  return !CHAIN.test(c) && PORT_FLAG.test(c);
}

/**
 * The dev command with `--port` for the worktree's own port, or null when FORGE cannot tell whether
 * the command accepts it (then only the PORT variable carries the port). `pnpm dev` passes the
 * flag on to the script; npm needs `--` for that.
 */
export async function withPortFlag(command: string, port: number, dir: string): Promise<string | null> {
  const c = command.trim();
  if (takesPortFlag(c)) return `${c} --port ${port}`;
  const m = SCRIPT_CALL.exec(c);
  if (!m) return null;
  const [, pm, , script] = m;
  let body: string | undefined;
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    body = pkg.scripts?.[script!];
  } catch {
    return null;
  }
  if (!body || !takesPortFlag(body)) return null;
  if (pm === "npm") return `npm run ${script} -- --port ${port}`;
  return `${c} --port ${port}`;
}
