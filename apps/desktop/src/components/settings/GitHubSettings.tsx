import { useDiagnostics } from "@/lib/queries";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { Group } from "./layout";

export function GitHubSettings() {
  const gh = useDiagnostics().data?.gh;
  useAutoOpenGitHub();
  return (
    <Group title="GitHub" description="Für private Repositories, Push, Pull Requests und die Repository-Auswahl beim Klonen.">
      <div className="p-4">
        {gh && !gh.found ? (
          <p className="text-body text-danger">Die GitHub-Anbindung fehlt in dieser Installation. Bitte FORGE neu installieren.</p>
        ) : (
          <GitHubAccountCard />
        )}
      </div>
    </Group>
  );
}
