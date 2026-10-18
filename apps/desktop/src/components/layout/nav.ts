import { Blocks, CalendarDays, FolderKanban, History, Home, Settings, type LucideIcon } from "lucide-react";
import type { View } from "@/stores/ui";
import { t } from "@/i18n";

/** Main views, shared by the sidebar and the command palette. */
export const NAV: ReadonlyArray<{ view: View; label: string; Icon: LucideIcon }> = [
  { view: "home", label: t.layout.nav.home, Icon: Home },
  { view: "projects", label: t.layout.nav.projects, Icon: FolderKanban },
  { view: "sessions", label: t.layout.nav.sessions, Icon: History },
  { view: "report", label: t.layout.nav.report, Icon: CalendarDays },
  { view: "mcp", label: t.layout.nav.extensions, Icon: Blocks },
  { view: "settings", label: t.layout.nav.settings, Icon: Settings },
];
