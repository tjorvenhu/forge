import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import { languageFor, type LanguageDescription } from "./file-language";

const v = (name: string) => `var(--syntax-${name})`;

// Token mapping follows VS Code "Dark Modern": control flow purple, declarations blue, calls yellow.
const vscodeTheme = createTheme({
  theme: "dark",
  settings: {
    background: "var(--color-bg)",
    foreground: v("fg"),
    caret: v("fg"),
    selection: "var(--color-accent-soft)",
    selectionMatch: "var(--color-surface-3)",
    lineHighlight: "var(--color-surface)",
    gutterBackground: "var(--color-bg)",
    gutterForeground: v("line-number"),
    gutterActiveForeground: v("fg"),
    gutterBorder: "transparent",
    fontFamily: "var(--font-mono)",
  },
  styles: [
    { tag: [t.controlKeyword, t.moduleKeyword], color: v("control") },
    { tag: [t.keyword, t.definitionKeyword, t.modifier, t.operatorKeyword, t.bool, t.null, t.self, t.atom], color: v("keyword") },
    { tag: [t.string, t.special(t.string), t.character, t.docString, t.attributeValue], color: v("string") },
    { tag: t.regexp, color: v("regexp") },
    { tag: t.escape, color: v("escape") },
    { tag: [t.number, t.integer, t.float, t.unit], color: v("number") },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v("comment") },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: v("function") },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: v("type") },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: v("constant") },
    { tag: [t.variableName, t.propertyName, t.definition(t.propertyName), t.attributeName, t.labelName], color: v("variable") },
    { tag: t.tagName, color: v("keyword") },
    { tag: t.angleBracket, color: v("tag-bracket") },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: v("fg") },
    { tag: t.meta, color: v("keyword") },
    { tag: t.invalid, color: v("invalid") },
    // Markdown
    { tag: t.heading, color: v("keyword"), fontWeight: "600" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: v("variable") },
    { tag: t.monospace, color: v("string") },
    { tag: t.quote, color: v("comment") },
    { tag: [t.list, t.processingInstruction, t.contentSeparator], color: v("keyword") },
  ],
});

const base = EditorView.theme({
  "&": { fontSize: "13px", height: "100%" },
  ".cm-scroller": { lineHeight: "1.55" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "8px 0" },
  ".cm-gutters": { paddingLeft: "8px" },
  ".cm-lineNumbers .cm-gutterElement": { paddingRight: "12px" },
});

export interface CodeViewProps {
  path: string;
  content: string;
  /** Shown in the status bar when the sidecar cut the file off. */
  truncated?: boolean;
  /** 1-based line to show in the middle and mark; `jumpKey` changes to jump there again */
  line?: number;
  jumpKey?: number;
}

/** Read-only file preview with syntax highlighting picked from the file name. */
export function CodeView({ path, content, truncated, line, jumpKey }: CodeViewProps) {
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    if (!view || !line) return;
    const doc = view.state.doc;
    const at = doc.line(Math.min(Math.max(1, line), doc.lines));
    view.dispatch({ selection: { anchor: at.from, head: at.to }, effects: EditorView.scrollIntoView(at.from, { y: "center" }) });
  }, [view, line, jumpKey, content]);
  const desc = useMemo(() => languageFor(path), [path]);
  const isMarkdown = desc?.name === "Markdown";
  // Grammars load on first use; CodeMirror caches them on the description afterwards.
  const [loaded, setLoaded] = useState<{ desc: LanguageDescription; ext: Extension } | null>(null);
  useEffect(() => {
    if (!desc || isMarkdown || desc.support) return;
    let current = true;
    desc.load().then(
      (ext) => current && setLoaded({ desc, ext }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [desc, isMarkdown]);
  // language-data's Markdown leaves fenced code plain; with codeLanguages it is highlighted too.
  const markdownExt = useMemo(() => (isMarkdown ? markdown({ base: markdownLanguage, codeLanguages: languages }) : null), [isMarkdown]);
  const lang = markdownExt ?? desc?.support ?? (loaded?.desc === desc ? loaded.ext : null);

  const extensions = useMemo((): Extension[] => [base, EditorView.contentAttributes.of({ "aria-label": path }), ...(lang ? [lang] : [])], [lang, path]);

  const lines = useMemo(() => content.split("\n").length, [content]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CodeMirror
        value={content}
        theme={vscodeTheme}
        extensions={extensions}
        readOnly
        onCreateEditor={setView}
        height="100%"
        className="min-h-0 flex-1 overflow-hidden"
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, autocompletion: false }}
      />
      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border px-3 text-2xs text-muted">
        {truncated && <span className="text-warning">Vorschau auf 512 KB gekürzt</span>}
        <span className="ml-auto">{lines === 1 ? "1 Zeile" : `${lines} Zeilen`}</span>
        <span>{desc?.name ?? "Nur Text"}</span>
      </div>
    </div>
  );
}
