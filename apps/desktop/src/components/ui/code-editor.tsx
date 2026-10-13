import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./code-editor-impl";
import { EditorSkeleton } from "./skeleton";

/** CodeMirror is large and only needed in a few editors; it loads with the first one shown. */
const Impl = lazy(() => import("./code-editor-impl").then((m) => ({ default: m.CodeEditor })));

export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<EditorSkeleton className="rounded-lg" />}>
      <Impl {...props} />
    </Suspense>
  );
}
