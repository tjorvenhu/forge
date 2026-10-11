import { useEffect, useRef } from "react";
import { attachTerminal } from "@/lib/terminal-registry";
import type { TerminalTab } from "@/stores/terminals";

/**
 * Shows the PTY-backed terminal of one tab. Unmounting only detaches it: the process keeps running
 * across project and view switches until the tab is closed.
 */
export function TerminalView({ tab }: { tab: TerminalTab }) {
  const host = useRef<HTMLDivElement>(null);
  const { key, cwd, program, claudePath } = tab;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    return attachTerminal(key, el, { cwd, program, claudePath });
  }, [key, cwd, program, claudePath]);

  return <div ref={host} className="h-full w-full" />;
}
