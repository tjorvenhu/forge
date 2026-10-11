import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResultOf } from "@forge/protocol";
import { call } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Command = ResultOf<"system.commands">[number];

/** Slash commands matching the composer text while it is a single "/word". */
export function useSlashCommands(projectId: string, text: string): Command[] {
  const slashMode = /^\/[^\s]*$/.test(text);
  const commands = useQuery({
    queryKey: ["commands", projectId],
    queryFn: () => call("system.commands", { projectId }),
    enabled: slashMode,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    if (!slashMode) return [];
    const q = text.slice(1).toLowerCase();
    return (commands.data ?? []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [slashMode, text, commands.data]);
}

export function SlashCommandMenu({ matches, index, onPick }: { matches: Command[]; index: number; onPick: (name: string) => void }) {
  if (!matches.length) return null;
  return (
    <div className="absolute bottom-full left-6 right-6 z-20 mx-auto mb-1 max-w-4xl overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl" role="listbox" aria-label="Slash-Commands">
      {matches.map((c, i) => (
        <button
          key={c.name}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c.name);
          }}
          className={cn("flex w-full items-baseline gap-3 px-3 py-1.5 text-left", i === index ? "bg-surface-3" : "hover:bg-surface-3")}
        >
          <span className="shrink-0 font-mono text-small-lg text-accent">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 font-mono text-caption text-subtle">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-xs text-muted">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
