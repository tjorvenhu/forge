/** Repository whose releases carry the FORGE builds. */
const REPO = "vanturis/forge";
const CACHE_MS = 15 * 60_000;

export type Os = "windows" | "macos" | "linux";

/** A file of the newest release that has builds for macOS or Linux, for the manual download. */
export interface BuildFile {
  label: string;
  url: string;
}

export interface Builds {
  /** version of the newest release with macOS builds, null while there is none */
  macos: { version: string; files: BuildFile[] } | null;
  linux: { version: string; files: BuildFile[] } | null;
}

type Asset = { name?: string; browser_download_url?: string };
type Release = { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Asset[] };

/** File names of the release workflow (ADR 0014) and how the download page names them. */
const FILES: Record<"macos" | "linux", { pattern: RegExp; label: string }[]> = {
  macos: [
    { pattern: /^FORGE_[^_]+_darwin-arm64\.dmg$/, label: "Apple silicon (.dmg)" },
    { pattern: /^FORGE_[^_]+_darwin-x64\.dmg$/, label: "Intel (.dmg)" },
  ],
  linux: [
    { pattern: /^FORGE_[^_]+_linux-x64\.AppImage$/, label: "AppImage" },
    { pattern: /^FORGE_[^_]+_linux-x64\.deb$/, label: "Debian, Ubuntu (.deb)" },
  ],
};

function newest(releases: Release[], os: "macos" | "linux"): Builds["macos"] {
  for (const r of releases) {
    // Pre-releases are dev builds (and the FORGE Setup release); new installations get the stable one.
    if (r.draft || r.prerelease) continue;
    const files = FILES[os].flatMap(({ pattern, label }) => {
      const a = r.assets?.find((x) => x.name && pattern.test(x.name));
      return a?.browser_download_url ? [{ label, url: a.browser_download_url }] : [];
    });
    if (files.length) return { version: (r.tag_name ?? "").replace(/^v/, ""), files };
  }
  return null;
}

export function findBuilds(releases: Release[]): Builds {
  return { macos: newest(releases, "macos"), linux: newest(releases, "linux") };
}

let cache: { value: Builds; at: number } | null = null;

/** The newest macOS and Linux builds from the GitHub API without login, at most every 15 minutes. */
export async function latestBuilds(fetchFn: typeof fetch = fetch): Promise<Builds> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases?per_page=40`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "forge-stats" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
  cache = { value: findBuilds((await res.json()) as Release[]), at: Date.now() };
  return cache.value;
}

/** The visitor's system from the client hint Chrome and Edge send, else from the user agent; null on phones. */
export function detectOs(platformHint: string | null, userAgent: string | null): Os | null {
  const hint = platformHint?.replace(/"/g, "").toLowerCase();
  if (hint === "windows") return "windows";
  if (hint === "macos") return "macos";
  if (hint === "linux" || hint === "chrome os") return "linux";
  if (hint === "android" || hint === "ios") return null;
  const ua = userAgent ?? "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}
