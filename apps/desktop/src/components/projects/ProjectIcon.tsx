import { cn } from "@/lib/utils";

// Full class names, so Tailwind finds them in the source.
const TILE_COLORS = [
  "border-tile-orange/20 bg-tile-orange/12 text-tile-orange",
  "border-tile-amber/20 bg-tile-amber/12 text-tile-amber",
  "border-tile-lime/20 bg-tile-lime/12 text-tile-lime",
  "border-tile-green/20 bg-tile-green/12 text-tile-green",
  "border-tile-teal/20 bg-tile-teal/12 text-tile-teal",
  "border-tile-cyan/20 bg-tile-cyan/12 text-tile-cyan",
  "border-tile-sky/20 bg-tile-sky/12 text-tile-sky",
  "border-tile-blue/20 bg-tile-blue/12 text-tile-blue",
  "border-tile-indigo/20 bg-tile-indigo/12 text-tile-indigo",
  "border-tile-violet/20 bg-tile-violet/12 text-tile-violet",
  "border-tile-fuchsia/20 bg-tile-fuchsia/12 text-tile-fuchsia",
  "border-tile-pink/20 bg-tile-pink/12 text-tile-pink",
] as const;

/** Color of a project's tile: a hash of its id, so it survives restarts and renames without being stored. */
function projectTileColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return TILE_COLORS[(h >>> 0) % TILE_COLORS.length]!;
}

/**
 * Deterministic initials tile; no external images, no brand marks. `id` picks the color; pass the
 * root project's id for worktrees, so agents keep the color of their project.
 */
export function ProjectIcon({ id, name, size = 32, className }: { id: string; name: string; size?: number; className?: string }) {
  const initials =
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center rounded-lg border font-semibold", projectTileColor(id), className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
