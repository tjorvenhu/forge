import { Blocks, PackageSearch, PenLine, Server, Webhook, type LucideIcon } from "lucide-react";
import { useProject } from "@/lib/queries";
import { useUi, type ExtensionsTab, type SkillsTab } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { TabBar } from "@/components/ui/tabs";
import { DocsTab } from "@/components/extensions/DocsTab";
import { HooksTab } from "@/components/extensions/HooksTab";
import { McpTab } from "@/components/extensions/McpTab";
import { SkillMarketplace } from "@/components/extensions/SkillMarketplace";

/** Tabs of the view, shared with the command palette. */
export const EXTENSION_TAB_DEFS: ReadonlyArray<{ value: ExtensionsTab; label: string; Icon: LucideIcon }> = [
  { value: "mcp", label: "MCP Server", Icon: Server },
  { value: "skills", label: "Skills", Icon: Blocks },
  { value: "hooks", label: "Hooks", Icon: Webhook },
];

export const SKILLS_TAB_DEFS: ReadonlyArray<{ value: SkillsTab; label: string; Icon: LucideIcon }> = [
  { value: "marketplace", label: "Marketplace", Icon: PackageSearch },
  { value: "own", label: "Eigene Skills", Icon: PenLine },
];

/** Claude Code extensions: MCP servers, skills and hooks, for the user and the open project. */
export function ExtensionsView() {
  const tab = useUi((s) => s.extensionsTab);
  const setTab = useUi((s) => s.setExtensionsTab);
  const skillsTab = useUi((s) => s.skillsTab);
  const setSkillsTab = useUi((s) => s.setSkillsTab);
  const projectId = useUi((s) => s.activeProjectId) ?? undefined;
  const project = useProject(projectId ?? null);
  return (
    <Page
      title="Erweiterungen"
      subtitle={project.data ? `Global und für ${project.data.name}` : "Global (öffne ein Projekt, um Projekt-Erweiterungen zu sehen)"}
    >
      <div className="mb-4 border-b border-border">
        <TabBar<ExtensionsTab> value={tab} onChange={setTab} tabs={EXTENSION_TAB_DEFS.map((t) => ({ value: t.value, label: t.label, icon: <t.Icon className="h-3.5 w-3.5" /> }))} />
      </div>
      <div className="max-w-5xl">
        {tab === "mcp" && <McpTab projectId={projectId} />}
        {tab === "skills" && (
          <>
            <div className="mb-3">
              <TabBar<SkillsTab>
                value={skillsTab}
                onChange={setSkillsTab}
                tabs={SKILLS_TAB_DEFS.map((t) => ({ value: t.value, label: t.label, icon: <t.Icon className="h-3.5 w-3.5" /> }))}
              />
            </div>
            {skillsTab === "marketplace" ? <SkillMarketplace /> : <DocsTab kind="skill" projectId={projectId} />}
          </>
        )}
        {tab === "hooks" && <HooksTab projectId={projectId} />}
      </div>
    </Page>
  );
}
