import { lazy, Suspense } from "react";
import type { CodeViewProps } from "./code-view-impl";

/** Loads with CodeMirror on the first opened file, like the CodeEditor. */
const Impl = lazy(() => import("./code-view-impl").then((m) => ({ default: m.CodeView })));

export function CodeView(props: CodeViewProps) {
  return (
    <Suspense fallback={<div className="h-full min-h-24 w-full animate-pulse bg-surface-2" aria-label="Vorschau lädt" />}>
      <Impl {...props} />
    </Suspense>
  );
}
