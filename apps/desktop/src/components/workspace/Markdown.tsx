import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternal } from "@/lib/native";

/** Renders assistant markdown. Raw HTML is not rendered; links open in the system browser. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown break-words text-ui leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href) void openExternal(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
