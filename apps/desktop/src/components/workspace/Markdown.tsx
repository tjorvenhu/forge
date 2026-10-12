import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { openExternal } from "@/lib/native";
import { toast } from "@/stores/toast";

const PLUGINS = [remarkGfm];

/** Renders assistant markdown. Raw HTML is not rendered; links open in the system browser. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown break-words text-ui">
      <MarkdownBody text={text} />
    </div>
  );
});

/** The parsed elements without a wrapper; memoized, so an unchanged block is not parsed again. */
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Markdown while it streams in: split into blocks at blank lines (outside code fences), so only the
 * last, growing block is parsed again; finished blocks keep their text and are skipped. Once the
 * message is complete it is rendered as a whole with `Markdown`.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const blocks = splitMarkdownBlocks(text);
  return (
    <div className="markdown break-words text-ui">
      {blocks.map((b, i) => (
        <MarkdownBody key={i} text={b} />
      ))}
    </div>
  );
});

/** Blocks separated by blank lines; a code fence stays in one block, also with blank lines inside. */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1]!;
      else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
    }
    if (fence === null && !line.trim()) {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () =>
    navigator.clipboard.writeText(ref.current?.textContent ?? "").then(
      () => setCopied(true),
      () => toast.error("Nicht kopiert", "Die Zwischenablage ist nicht erreichbar."),
    );
  return (
    <div className="code-block group/code">
      <pre ref={ref}>{children}</pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Code kopiert" : "Code kopieren"}
        title="Code kopieren"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface-2 text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/code:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// Module-level so the code block keeps its state (copied) while streaming text re-renders the markdown.
const COMPONENTS = { a: Link, pre: CodeBlock };
