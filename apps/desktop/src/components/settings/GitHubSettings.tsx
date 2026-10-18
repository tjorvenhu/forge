import { useDiagnostics } from "@/lib/queries";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { t } from "@/i18n";
import { Group } from "./layout";

export function GitHubSettings() {
  const gh = useDiagnostics().data?.gh;
  useAutoOpenGitHub();
  return (
    <Group title={t.settings.github.title} description={t.settings.github.description}>
      <div className="p-4">
        {gh && !gh.found ? (
          <p className="text-body text-danger">{t.settings.github.missing}</p>
        ) : (
          <GitHubAccountCard />
        )}
      </div>
    </Group>
  );
}
