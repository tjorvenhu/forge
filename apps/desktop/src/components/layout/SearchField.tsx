import { Search } from "lucide-react";
import { useUi } from "@/stores/ui";
import { Kbd } from "@/components/ui/misc";

/** Looks like a search box, opens the command palette (Ctrl+K). Sits in the sidebar above the navigation. */
export function SearchField() {
  return (
    <button
      onClick={() => useUi.getState().setPaletteOpen(true)}
      className="flex h-9 w-full items-center gap-2.5 whitespace-nowrap rounded-lg border border-border bg-surface px-3 text-body-lg text-subtle transition-colors hover:border-border-strong hover:text-muted"
      aria-label="Suchen und Befehle (Strg+K)"
    >
      <Search className="h-4 w-4" />
      <span className="flex-1 text-left">Suchen …</span>
      <Kbd>Strg K</Kbd>
    </button>
  );
}
