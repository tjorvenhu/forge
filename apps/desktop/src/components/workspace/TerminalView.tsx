import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** Terminal colors resolved from the CSS tokens at mount time. */
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

/**
 * One PTY-backed terminal. `program` is "shell" or "claude"; the process lives as long as the view.
 */
export function TerminalView({ cwd, program, claudePath, onExit }: { cwd: string; program: "shell" | "claude"; claudePath?: string | null; onExit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSize: 12.5,
      cursorBlink: true,
      theme: themeFromTokens(),
      allowProposedApi: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let id: number | null = null;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      unlisteners.push(
        await listen<{ id: number; data: string }>("term://data", (e) => {
          if (e.payload.id === id) term.write(e.payload.data);
        }),
      );
      unlisteners.push(
        await listen<{ id: number }>("term://exit", (e) => {
          if (e.payload.id !== id) return;
          term.write("\r\n\x1b[90m[Prozess beendet]\x1b[0m\r\n");
          exitRef.current?.();
        }),
      );
      try {
        id = await invoke<number>("term_open", { cwd, cols: term.cols, rows: term.rows, program, claudePath: claudePath ?? null });
        if (disposed) void invoke("term_close", { id });
      } catch (e) {
        term.write(`\x1b[31mTerminal konnte nicht gestartet werden: ${String(e)}\x1b[0m\r\n`);
      }
    })();

    const sub = term.onData((data) => {
      if (id !== null) void invoke("term_write", { id, data });
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (id !== null) void invoke("term_resize", { id, cols: term.cols, rows: term.rows });
      } catch {
        /* element hidden */
      }
    });
    ro.observe(el);
    term.focus();

    return () => {
      disposed = true;
      ro.disconnect();
      sub.dispose();
      unlisteners.forEach((u) => u());
      if (id !== null) void invoke("term_close", { id });
      term.dispose();
    };
  }, [cwd, program, claudePath]);

  return <div ref={host} className="h-full w-full px-2 py-1" />;
}
