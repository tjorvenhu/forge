/** Repository whose releases carry the FORGE installers. */
const REPO = "vanturis/forge";
/** Only real downloads count: the full installer. Update zips, signatures and runtime markers are fetched by installed apps. */
const INSTALLER = /-setup\.exe$/i;
const CACHE_MS = 30 * 60_000;
/** One page per push to main; 20 pages are 2000 releases. */
const MAX_PAGES = 20;

type Asset = { name?: string; download_count?: number };
type Release = { assets?: Asset[] };

export function countInstallerDownloads(releases: Release[]): number {
  let n = 0;
  for (const r of releases) for (const a of r.assets ?? []) if (a.name && INSTALLER.test(a.name)) n += a.download_count ?? 0;
  return n;
}

let cache: { value: number; at: number } | null = null;

/** Installer downloads over all releases, from the GitHub API without login, at most every 30 minutes. */
export async function installerDownloads(fetchFn: typeof fetch = fetch): Promise<number> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const releases: Release[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "forge-stats" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
    const list = (await res.json()) as Release[];
    releases.push(...list);
    if (list.length < 100) break;
  }
  cache = { value: countInstallerDownloads(releases), at: Date.now() };
  return cache.value;
}
