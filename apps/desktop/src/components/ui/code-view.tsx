import { lazy, Suspense } from "react";
import type { CodeViewProps } from "./code-view-impl";
import { CodeSkeleton, Skeleton } from "./skeleton";

/** Loads with CodeMirror on the first opened file, like the CodeEditor. */
const Impl = lazy(() => import("./code-view-impl").then((m) => ({ default: m.CodeView })));

/** The file preview while the file or CodeMirror loads, with the same status bar as CodeView. */
export function CodeViewSkeleton({ label = "Vorschau lädt" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeSkeleton label={label} lines={24} className="min-h-0 flex-1" />
      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border px-3" aria-hidden>
        <Skeleton className="ml-auto h-2 w-12 rounded-sm" />
        <Skeleton className="h-2 w-16 rounded-sm" />
      </div>
    </div>
  );
}

export function CodeView(props: CodeViewProps) {
  return (
    <Suspense fallback={<CodeViewSkeleton />}>
      <Impl {...props} />
    </Suspense>
  );
}
