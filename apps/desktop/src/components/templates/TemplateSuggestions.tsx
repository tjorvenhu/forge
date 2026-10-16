import { FileStack } from "lucide-react";
import type { PromptTemplate } from "@forge/protocol";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/misc";

/**
 * Templates above the composer: suggested because the typed text resembles them, or listed after "#".
 * `index` -1: none chosen yet, Enter still sends the message.
 */
export function TemplateSuggestions({
  templates,
  index,
  explicit,
  onPick,
}: {
  templates: PromptTemplate[];
  index: number;
  /** "#" in front: the user asked for templates */
  explicit: boolean;
  onPick: (t: PromptTemplate) => void;
}) {
  if (!templates.length) return null;
  return (
    <div className="absolute bottom-full left-6 right-6 z-20 mb-1 animate-rise-in overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1.5 text-caption text-subtle">
        <span className="flex items-center gap-1.5">
          <FileStack className="h-3.5 w-3.5" />
          {explicit ? "Vorlagen" : templates.length === 1 ? "Passende Vorlage" : "Passende Vorlagen"}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Tab</Kbd> übernehmen
          {!explicit && (
            <>
              <span aria-hidden>·</span>
              <Kbd>↓</Kbd> wählen
            </>
          )}
          <span aria-hidden>·</span>
          <Kbd>Esc</Kbd> ausblenden
        </span>
      </div>
      <div role="listbox" aria-label="Vorlagen">
        {templates.map((t, i) => (
          <button
            key={t.id}
            role="option"
            aria-selected={i === index}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(t);
            }}
            className={cn("flex w-full items-baseline gap-3 px-3 py-1.5 text-left", i === index ? "bg-surface-3" : "hover:bg-surface-3")}
          >
            <span className="shrink-0 text-small-lg font-medium text-accent">{t.name}</span>
            <span className="min-w-0 truncate text-xs text-muted">{t.description || t.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
