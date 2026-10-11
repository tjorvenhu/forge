import { useState } from "react";
import { Blocks, Bot, Server, Webhook } from "lucide-react";
import { useProject } from "@/lib/queries";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { TabBar } from "@/components/ui/tabs";
import { DocsTab } from "@/components/extensions/DocsTab";
import { HooksTab } from "@/components/extensions/HooksTab";
import { McpTab } from "@/components/extensions/McpTab";

type Tab = "mcp" | "skills" | "agents" | "hooks";

/** Claude Code extensions: MCP servers, skills, subagents and hooks, for the user and the open project. */
export function ExtensionsView() {
  const [tab, setTab] = useState<Tab>("mcp");
  const projectId = useUi((s) => s.activeProjectId) ?? undefined;
  const project = useProject(projectId ?? null);
  return (
    <Page
      title="Erweiterungen"
      subtitle={project.data ? `Global und für ${project.data.name}` : "Global (öffne ein Projekt, um Projekt-Erweiterungen zu sehen)"}
    >
      <div className="mb-4 border-b border-border">
        <TabBar<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "mcp", label: "MCP Server", icon: <Server className="h-3.5 w-3.5" /> },
            { value: "skills", label: "Skills", icon: <Blocks className="h-3.5 w-3.5" /> },
            { value: "agents", label: "Subagenten", icon: <Bot className="h-3.5 w-3.5" /> },
            { value: "hooks", label: "Hooks", icon: <Webhook className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="max-w-5xl">
        {tab === "mcp" && <McpTab projectId={projectId} />}
        {tab === "skills" && <DocsTab kind="skill" projectId={projectId} />}
        {tab === "agents" && <DocsTab kind="agent" projectId={projectId} />}
        {tab === "hooks" && <HooksTab projectId={projectId} />}
      </div>
    </Page>
  );
}
