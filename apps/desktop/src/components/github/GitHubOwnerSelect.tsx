import { useGitHubAccount, useGitHubOrgs } from "@/lib/queries";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const PERSONAL = "__personal";

/** Repository name as GitHub gets it from FORGE (same rule as toRepoName in the sidecar). */
export function repoNameOf(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[.-]+/, "").slice(0, 100) || "projekt";
}

/**
 * Where a new repository goes: the personal account or one of its organisations. `value` "" is the
 * personal account. Renders nothing while nobody is signed in to GitHub.
 */
export function GitHubOwnerSelect({ value, onChange, className }: { value: string; onChange: (owner: string) => void; className?: string }) {
  const account = useGitHubAccount();
  const orgs = useGitHubOrgs(!!account.data);
  if (!account.data) return null;
  if (orgs.isPending) {
    return (
      <SkeletonRegion label={t.github.owner.loading} className={className}>
        <Skeleton className="h-8 w-full" />
      </SkeletonRegion>
    );
  }
  return (
    <div className={className}>
      <Select<string>
        value={value || PERSONAL}
        onChange={(v) => onChange(v === PERSONAL ? "" : v)}
        options={[
          { value: PERSONAL, label: account.data.login, description: t.github.owner.personal },
          ...(orgs.data ?? []).map((o) => ({ value: o.login, label: o.login, description: t.github.owner.organization })),
        ]}
        aria-label={t.github.owner.aria}
        className="w-full"
      />
      {orgs.isError && <p className="mt-1 text-xs text-danger">{t.github.owner.loadFailed}</p>}
    </div>
  );
}
