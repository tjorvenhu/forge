import { useGitHubAccount, useGitHubOrgs } from "@/lib/queries";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

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
      <SkeletonRegion label="Lädt Organisationen" className={className}>
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
          { value: PERSONAL, label: account.data.login, description: "Persönliches Konto" },
          ...(orgs.data ?? []).map((o) => ({ value: o.login, label: o.login, description: "Organisation" })),
        ]}
        aria-label="Konto oder Organisation"
        className="w-full"
      />
      {orgs.isError && <p className="mt-1 text-xs text-danger">Organisationen konnten nicht geladen werden.</p>}
    </div>
  );
}
