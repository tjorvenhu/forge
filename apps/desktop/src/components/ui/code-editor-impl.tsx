import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { EditorView, keymap } from "@codemirror/view";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";

// Colors reference the CSS tokens so the editor follows the app theme.
const forgeTheme = createTheme({
  theme: "dark",
  settings: {
    background: "var(--color-bg)",
    foreground: "var(--color-fg)",
    caret: "var(--color-accent)",
    selection: "var(--color-accent-soft)",
    selectionMatch: "var(--color-accent-soft)",
    lineHighlight: "var(--color-surface)",
    gutterBackground: "var(--color-bg)",
    gutterForeground: "var(--color-subtle)",
    gutterBorder: "transparent",
    fontFamily: "var(--font-mono)",
  },
  styles: [
    { tag: [t.heading1, t.heading2, t.heading3, t.heading4], color: "var(--color-fg)", fontWeight: "600" },
    { tag: t.heading, color: "var(--color-accent)" },
    { tag: [t.strong], fontWeight: "600" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.link, t.url], color: "var(--color-accent)" },
    { tag: [t.monospace], color: "var(--color-warning)" },
    { tag: [t.list, t.quote], color: "var(--color-muted)" },
    { tag: [t.string], color: "var(--color-success)" },
    { tag: [t.number, t.bool, t.null], color: "var(--color-warning)" },
    { tag: [t.propertyName], color: "var(--color-accent)" },
    { tag: [t.comment, t.meta], color: "var(--color-subtle)" },
  ],
});

const base = EditorView.theme({
  "&": { fontSize: "12.5px", height: "100%" },
  ".cm-scroller": { lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "10px 0" },
});

export interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language: "markdown" | "json";
  onSave?: () => void;
  readOnly?: boolean;
  ariaLabel: string;
}

/** CodeMirror with FORGE styling. Ctrl+S calls onSave. */
export function CodeEditor({ value, onChange, language, onSave, readOnly, ariaLabel }: CodeEditorProps) {
  // Callers pass inline lambdas; reading through a ref keeps the extensions stable so the editor
  // is not reconfigured on every keystroke.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const extensions = useMemo(
    () => [
      language === "markdown" ? markdown({ base: markdownLanguage }) : json(),
      EditorView.lineWrapping,
      base,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
      ]),
    ],
    [language, ariaLabel],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={forgeTheme}
      extensions={extensions}
      readOnly={readOnly}
      height="100%"
      className="h-full overflow-hidden rounded-lg border border-border"
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
    />
  );
}
