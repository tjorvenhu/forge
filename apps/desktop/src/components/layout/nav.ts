import { Blocks, Bot, FolderKanban, GitPullRequest, History, Home, Settings, type LucideIcon } from "lucide-react";
import type { View } from "@/stores/ui";

/** Main views, shared by the sidebar and the command palette. */
export const NAV: ReadonlyArray<{ view: View; label: string; Icon: LucideIcon }> = [
  { view: "home", label: "Start", Icon: Home },
  { view: "projects", label: "Projekte", Icon: FolderKanban },
  { view: "sessions", label: "Sessions", Icon: History },
  { view: "github", label: "GitHub", Icon: GitPullRequest },
  { view: "agents", label: "Agenten", Icon: Bot },
  { view: "mcp", label: "Erweiterungen", Icon: Blocks },
  { view: "settings", label: "Einstellungen", Icon: Settings },
];
