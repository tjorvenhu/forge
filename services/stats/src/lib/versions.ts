export interface VersionCount {
  version: string;
  installs: number;
}

function parts(v: string): { nums: number[]; pre: string | null } {
  const [core = "", pre] = v.split("+")[0]!.split(/-(.*)/s);
  return { nums: core.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : -1)), pre: pre ?? null };
}

/** Semver order: 0.1.80 > 0.1.9, a release above its pre-release (1.0.0 > 1.0.0-beta). */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre, "en", { numeric: true });
}

export function newestVersion(versions: VersionCount[]): string | null {
  return versions.reduce<string | null>((max, v) => (max === null || compareVersions(v.version, max) > 0 ? v.version : max), null);
}
