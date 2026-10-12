import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./code-editor-impl";

/** CodeMirror is large and only needed in a few editors; it loads with the first one shown. */
const Impl = lazy(() => import("./code-editor-impl").then((m) => ({ default: m.CodeEditor })));

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="h-full min-h-24 w-full animate-pulse rounded-md border border-border bg-surface-2" aria-label="Editor lädt" />}>
      <Impl {...props} />
    </Suspense>
  );
}
