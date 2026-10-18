import type { ui as De } from "../de/ui";

export const ui: typeof De = {
  close: "Close",
  cancel: "Cancel",
  info: "Info",
  error: "Error",
  selectPlaceholder: "Select",
  loading: "Loading",
  loadingEllipsis: "Loading …",
  loadingPreview: "Loading preview",
  loadingEditor: "Loading editor",
  loadingHistory: "Loading history",
  closeTab: (label: string) => `Close ${label}`,
  confirmType: { before: "Type", after: "to confirm" },
  codeView: {
    truncated: "Preview truncated to 512 KB",
    lines: (n: number) => (n === 1 ? "1 line" : `${n} lines`),
    plainText: "Plain text",
  },
  fileDraft: {
    changedOutside: "The file was changed outside of FORGE.",
    changedOutsideHint: "Reload discards your changes. If you keep editing, saving overwrites the file.",
    reload: "Reload",
    keepEditing: "Keep editing",
  },
};
