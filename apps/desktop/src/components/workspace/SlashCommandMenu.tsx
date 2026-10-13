import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResultOf } from "@forge/protocol";
import { call } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { INFO_COMMANDS } from "./InfoCommandDialog";

/** `builtin`: Claude Code's own command; absent for one of the user, the project, a plugin or an MCP server. */
type CliCommand = ResultOf<"system.commands">[number] & { builtin?: boolean };
export type Command = ResultOf<"system.commands">[number] & {
  /** a command of the user or project named like one FORGE shows as a dialog; it goes to Claude */
  custom?: boolean;
};

/** Commands FORGE handles itself instead of sending them to Claude Code (like /clear in the terminal). */
export const CLEAR_COMMANDS = ["clear", "reset", "new"];
const BUILT_IN: Command[] = [
  { name: "clear", description: "Neues Gespräch starten und den Chat leeren. Das bisherige bleibt in der Session-Liste.", argumentHint: "" },
  ...INFO_COMMANDS.map((c) => ({ name: c.name, description: c.description, argumentHint: "" })),
];
/** Handled by FORGE; the CLI's own entries of the same name are left out. */
const OWN = new Set([...CLEAR_COMMANDS, ...BUILT_IN.map((c) => c.name)]);
const INFO_NAMES = new Set(INFO_COMMANDS.map((c) => c.name));

/** The CLI's commands without those FORGE answers itself; own commands named like an info dialog stay as their own entry. */
export function cliCommands(list: CliCommand[]): Command[] {
  // Without any builtin mark the list cannot tell Claude Code's commands from the user's; FORGE's dialog then wins.
  const marked = list.some((c) => c.builtin === true);
  return list.flatMap((c): Command[] => {
    const name = c.name.toLowerCase();
    if (!OWN.has(name)) return [c];
    return marked && !c.builtin && INFO_NAMES.has(name) ? [{ name: c.name, description: c.description, argumentHint: c.argumentHint, custom: true }] : [];
  });
}

/** True for "/clear" and its aliases, exactly as typed in the composer. */
export function isClearCommand(text: string): boolean {
  const m = /^\/(\w+)$/.exec(text.trim());
  return !!m && CLEAR_COMMANDS.includes(m[1]!.toLowerCase());
}

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
    return [...BUILT_IN, ...cliCommands(commands.data ?? [])].filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [slashMode, text, commands.data]);
}

export function SlashCommandMenu({ matches, index, onPick }: { matches: Command[]; index: number; onPick: (command: Command) => void }) {
  if (!matches.length) return null;
  return (
    <div className="absolute bottom-full left-6 right-6 z-20 mb-1 animate-rise-in overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl" role="listbox" aria-label="Slash-Commands">
      {matches.map((c, i) => (
        <button
          key={c.custom ? `custom:${c.name}` : c.name}
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={cn("flex w-full items-baseline gap-3 px-3 py-1.5 text-left", i === index ? "bg-surface-3" : "hover:bg-surface-3")}
        >
          <span className="shrink-0 font-mono text-small-lg text-accent">/{c.name}</span>
          {c.custom && <span className="shrink-0 text-caption text-subtle">eigener Befehl</span>}
          {c.argumentHint && <span className="shrink-0 font-mono text-caption text-subtle">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-xs text-muted">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
