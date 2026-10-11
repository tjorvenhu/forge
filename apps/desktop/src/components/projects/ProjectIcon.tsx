import { cn } from "@/lib/utils";

/** Deterministic initials tile; no external images, no brand marks. */
export function ProjectIcon({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const initials =
    name
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  return (
    <div
      className={cn("flex shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent-soft font-semibold text-accent", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {initials}
    </div>
  );
}
