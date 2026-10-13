import { useEffect, useRef, useState } from "react";
import { attachTerminal, loadTerminalModule } from "@/lib/terminal-registry";
import type { TerminalTab } from "@/stores/terminals";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

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
  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      {!ready && <TerminalSkeleton />}
    </div>
  );
}

/** Prompt lines at xterm's padding and font size, so the terminal fades in where they stood. */
function TerminalSkeleton() {
  return (
    <SkeletonRegion label="Lädt Terminal" className="absolute inset-0 flex flex-col gap-1.5 px-2 py-1.5">
      {[38, 62, 24, 50].map((w, i) => (
        <div key={i} className="flex h-3 items-center gap-2">
          <Skeleton className="h-2.5 w-3 shrink-0 rounded-sm" />
          <Skeleton className="h-2.5 rounded-sm" style={{ width: `${w}%` }} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
