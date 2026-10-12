import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useTerminals, type TerminalProgram } from "@/stores/terminals";

/** xterm is loaded with the first terminal, not with the app: most sessions never open one. */
let xterm: { Terminal: typeof Terminal; FitAddon: typeof FitAddon } | null = null;
let loadingXterm: Promise<void> | null = null;

export function loadTerminalModule(): Promise<void> {
  loadingXterm ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]).then(
    ([x, f]) => {
      xterm = { Terminal: x.Terminal, FitAddon: f.FitAddon };
    },
    (e: unknown) => {
      loadingXterm = null;
      throw e;
    },
  );
  return loadingXterm;
}

export interface TerminalSpec {
  cwd: string;
  program: TerminalProgram;
  claudePath: string | null;
}

interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** owned container the terminal renders into; moved between hosts instead of re-creating the terminal */
  el: HTMLDivElement;
  opened: boolean;
  id: number | null;
  closed: boolean;
  size: { cols: number; rows: number };
  input: IDisposable;
}

const entries = new Map<string, Entry>();
const byId = new Map<number, Entry>();
/** Output and exits that arrive before term_open has returned the id of their PTY. */
const early = new Map<number, string[]>();
const earlyExit = new Set<number>();
let opening = 0;
let listening: Promise<void> | null = null;

/** Terminal colors resolved from the CSS tokens when the terminal is created. */
function themeFromTokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--color-bg"),
    foreground: v("--color-fg"),
    cursor: v("--color-accent"),
    selectionBackground: v("--color-border-strong"),
    black: v("--color-surface-3"),
    red: v("--color-danger"),
    green: v("--color-success"),
    yellow: v("--color-warning"),
    blue: v("--color-accent"),
    magenta: v("--color-accent-strong"),
    cyan: v("--color-accent"),
    white: v("--color-fg"),
    brightBlack: v("--color-subtle"),
  };
}

function markExited(entry: Entry) {
  if (entry.id !== null) byId.delete(entry.id);
  entry.id = null;
  entry.term.write("\r\n\x1b[90m[Prozess beendet]\x1b[0m\r\n");
}

/** One listener pair for all terminals, attached once for the lifetime of the app. */
function ensureListeners(): Promise<void> {
  listening ??= Promise.all([
    listen<{ id: number; data: string }>("term://data", (e) => {
      const entry = byId.get(e.payload.id);
      if (entry) entry.term.write(e.payload.data);
      else if (opening > 0) early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), e.payload.data]);
    }),
    listen<{ id: number }>("term://exit", (e) => {
      const entry = byId.get(e.payload.id);
      if (entry) markExited(entry);
      else if (opening > 0) earlyExit.add(e.payload.id);
    }),
  ]).then(
    () => undefined,
    (err: unknown) => {
      listening = null;
      throw err;
    },
  );
  return listening;
}

function syncSize(entry: Entry) {
  try {
    entry.fit.fit();
  } catch {
    /* container hidden */
    return;
  }
  const { cols, rows } = entry.term;
  if (entry.id === null || (cols === entry.size.cols && rows === entry.size.rows)) return;
  entry.size = { cols, rows };
  void invoke("term_resize", { id: entry.id, cols, rows });
}

async function startProcess(entry: Entry, spec: TerminalSpec) {
  opening++;
  try {
    await ensureListeners();
    if (entry.closed) return;
    const { cols, rows } = entry.term;
    const id = await invoke<number>("term_open", { cwd: spec.cwd, cols, rows, program: spec.program, claudePath: spec.program === "claude" ? spec.claudePath : null });
    if (entry.closed) {
      void invoke("term_close", { id });
      return;
    }
    entry.id = id;
    entry.size = { cols, rows };
    byId.set(id, entry);
    for (const chunk of early.get(id) ?? []) entry.term.write(chunk);
    early.delete(id);
    if (earlyExit.delete(id)) markExited(entry);
    else syncSize(entry);
  } catch (e) {
    entry.term.write(`\x1b[31mTerminal konnte nicht gestartet werden: ${String(e)}\x1b[0m\r\n`);
  } finally {
    opening--;
    if (opening === 0) {
      early.clear();
      earlyExit.clear();
    }
  }
}

function createEntry(): Entry {
  if (!xterm) throw new Error("loadTerminalModule() first");
  const term = new xterm.Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
    fontSize: 12.5,
    cursorBlink: true,
    theme: themeFromTokens(),
    allowProposedApi: false,
    scrollback: 5000,
  });
  const fit = new xterm.FitAddon();
  term.loadAddon(fit);
  const el = document.createElement("div");
  el.className = "h-full w-full px-2 py-1";
  const entry: Entry = { term, fit, el, opened: false, id: null, closed: false, size: { cols: 0, rows: 0 }, input: { dispose: () => {} } };
  entry.input = term.onData((data) => {
    if (entry.id !== null) void invoke("term_write", { id: entry.id, data });
  });
  return entry;
}

/**
 * Shows the terminal of `key` inside `host`, creating it and its process on first use. The returned
 * function only detaches it; the process keeps running until closeTerminal. Needs loadTerminalModule.
 */
export function attachTerminal(key: string, host: HTMLElement, spec: TerminalSpec): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = createEntry();
    entries.set(key, entry);
  }
  const e = entry;
  host.appendChild(e.el);
  if (!e.opened) {
    // xterm measures its font on open, so it opens only once the container is in the document.
    e.term.open(e.el);
    e.opened = true;
    syncSize(e);
    // Deferred: under StrictMode the first attach is detached again right away, which drops focus.
    requestAnimationFrame(() => {
      if (!e.closed && e.el.isConnected) e.term.focus();
    });
    void startProcess(e, spec);
  } else {
    syncSize(e);
    e.term.refresh(0, e.term.rows - 1);
  }
  const ro = new ResizeObserver(() => syncSize(e));
  ro.observe(host);
  return () => {
    ro.disconnect();
    if (e.el.parentElement === host) host.removeChild(e.el);
  };
}

/** Ends the process of a terminal tab and frees its terminal. */
export function closeTerminal(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  entry.closed = true;
  entry.input.dispose();
  if (entry.id !== null) {
    byId.delete(entry.id);
    void invoke("term_close", { id: entry.id });
  }
  entry.term.dispose();
  entry.el.remove();
}

/** Ends every terminal tab of these projects. Before deleting a folder: Windows keeps a shell's current folder locked. */
export function closeProjectTerminals(projectIds: string[]) {
  const store = useTerminals.getState();
  for (const projectId of projectIds) {
    for (const t of store.tabs[projectId] ?? []) {
      closeTerminal(t.key);
      store.remove(projectId, t.key);
    }
  }
}
