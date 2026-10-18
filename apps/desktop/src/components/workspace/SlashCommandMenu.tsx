import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ResultOf } from "@forge/protocol";
import { call } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { INFO_COMMANDS } from "./InfoCommandDialog";
import { t } from "@/i18n";

type CliCommand = ResultOf<"system.commands">[number];
export type Command = ResultOf<"system.commands">[number] & {
  /** a command of the user or project named like one FORGE shows as a dialog; it goes to Claude */
  custom?: boolean;
};

/** Commands FORGE handles itself instead of sending them to Claude Code (like /clear in the terminal). */
export const CLEAR_COMMANDS = ["clear", "reset", "new"];
const BUILT_IN: Command[] = [
  { name: "clear", description: t.chat.slash.clear, argumentHint: "" },
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

const MAX_MATCHES = 8;

/** `loading`: the commands of Claude Code and the user are still on their way and land below the built-in ones. */
export type SlashMatches = Command[] & { loading?: boolean };

/** Slash commands matching the composer text while it is a single "/word". */
export function useSlashCommands(projectId: string, text: string): SlashMatches {
  const slashMode = /^\/[^\s]*$/.test(text);
  const commands = useQuery({
    queryKey: ["commands", projectId],
    queryFn: () => call("system.commands", { projectId }),
    enabled: slashMode,
    staleTime: 5 * 60_000,
  });
  const loading = slashMode && commands.isLoading;
  return useMemo(() => {
    if (!slashMode) return [];
    const q = text.slice(1).toLowerCase();
    const list = [...BUILT_IN, ...cliCommands(commands.data ?? [])].filter((c) => c.name.toLowerCase().includes(q)).slice(0, MAX_MATCHES);
    return Object.assign(list, { loading });
  }, [slashMode, text, commands.data, loading]);
}

export function SlashCommandMenu({ matches, index, onPick }: { matches: SlashMatches; index: number; onPick: (command: Command) => void }) {
  const pending = matches.loading ? Math.min(2, MAX_MATCHES - matches.length) : 0;
  if (!matches.length && !pending) return null;
  return (
    <div className="absolute bottom-full left-6 right-6 z-20 mb-1 animate-rise-in overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl" role="listbox" aria-label={t.chat.slash.label}>
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
          {c.custom && <span className="shrink-0 text-caption text-subtle">{t.chat.slash.custom}</span>}
          {c.argumentHint && <span className="shrink-0 font-mono text-caption text-subtle">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-xs text-muted">{c.description}</span>
        </button>
      ))}
      {pending > 0 && (
        <SkeletonRegion label={t.chat.slash.loading}>
          {Array.from({ length: pending }, (_, i) => (
            <div key={i} className="box-content flex h-[1.5em] items-center gap-3 px-3 py-1.5 text-small-lg">
              <Skeleton className="h-3 w-20 shrink-0 rounded-sm bg-surface-3" />
              <Skeleton className="h-2.5 rounded-sm bg-surface-3" style={{ width: `${40 - i * 12}%` }} />
            </div>
          ))}
        </SkeletonRegion>
      )}
    </div>
  );
}
