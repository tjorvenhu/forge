import { Search } from "lucide-react";
import { useUi } from "@/stores/ui";
import { Kbd } from "@/components/ui/misc";

/** Looks like a search box, opens the command palette (Ctrl+K). */
export function SearchField() {
  const open = () => useUi.getState().setPaletteOpen(true);
  return (
    <>
      <button
        onClick={open}
        className="hidden h-9 w-64 items-center gap-2.5 rounded-lg border border-border bg-surface px-3 text-[13.5px] text-subtle transition-colors hover:border-border-strong hover:text-muted lg:flex"
        aria-label="Suchen und Befehle (Strg+K)"
      >
        <Search className="h-4 w-4" />
        <span className="flex-1 text-left">Suchen …</span>
        <Kbd>Strg K</Kbd>
      </button>
      <button onClick={open} className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-3 hover:text-fg lg:hidden" aria-label="Suchen und Befehle (Strg+K)">
        <Search className="h-4 w-4" />
      </button>
    </>
  );
}
