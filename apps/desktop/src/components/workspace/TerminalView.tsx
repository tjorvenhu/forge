import { useEffect, useRef, useState } from "react";
import { attachTerminal, loadTerminalModule } from "@/lib/terminal-registry";
import type { TerminalTab } from "@/stores/terminals";

/**
 * Shows the PTY-backed terminal of one tab. Unmounting only detaches it: the process keeps running
 * across project and view switches until the tab is closed.
 */
export function TerminalView({ tab }: { tab: TerminalTab }) {
  const host = useRef<HTMLDivElement>(null);
  const { key, cwd, program, claudePath } = tab;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadTerminalModule().then(
      () => alive && setReady(true),
      (e: unknown) => alive && setFailed(String(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !ready) return;
    return attachTerminal(key, el, { cwd, program, claudePath });
  }, [ready, key, cwd, program, claudePath]);

  if (failed) return <div className="p-3 text-small text-danger">Terminal konnte nicht geladen werden: {failed}</div>;
  return <div ref={host} className="h-full w-full" />;
}
