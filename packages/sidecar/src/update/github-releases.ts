import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { tr } from "../i18n/index.js";

export interface ReleaseAsset {
  name?: string;
  size?: number;
  digest?: string | null;
  /** API address of the asset; with Accept: application/octet-stream it delivers the file */
  url?: string;
  browser_download_url?: string;
}

/** Where the updater gets releases, commits and files; tests pass a fake. */
export interface ReleaseSource {
  /** releases of the repository, null when it has none or is not reachable as such (404) */
  releases(): Promise<unknown[] | null>;
  /** first lines of the commits between two tags, oldest first; empty when unknown */
  commits(base: string, head: string): Promise<string[]>;
  /** writes the asset to `file` */
  download(asset: ReleaseAsset, file: string, timeoutMs: number): Promise<void>;
}

type Fetch = typeof fetch;

const API = "https://api.github.com";

/**
 * Release access over plain HTTPS: anonymous for a public repository, so updates need no GitHub
 * account. Only when GitHub refuses (private repository, rate limit) it retries with the token of the
 * gh login, if there is one.
 */
export class GitHubReleases implements ReleaseSource {
  constructor(
    private readonly repo: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async request(url: string, accept: string, timeoutMs: number): Promise<Response> {
    const go = (token: string | null) =>
      this.fetchFn(url, {
        headers: {
          Accept: accept,
          "User-Agent": "FORGE-Updater",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    const res = await go(null);
    if (res.status !== 401 && res.status !== 403 && res.status !== 404 && res.status !== 429) return res;
    const token = await this.token().catch(() => null);
    if (!token) return res;
    await res.body?.cancel().catch(() => {});
    return go(token);
  }

  async releases(): Promise<unknown[] | null> {
    const res = await this.request(`${API}/repos/${this.repo}/releases?per_page=100`, "application/vnd.github+json", 30_000);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(httpError(res, tr().system.update.searchWhat));
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? data : [];
  }

  async commits(base: string, head: string): Promise<string[]> {
    try {
      const res = await this.request(`${API}/repos/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, "application/vnd.github+json", 10_000);
      if (!res.ok) return [];
      const data = (await res.json()) as { commits?: Array<{ commit?: { message?: string } }> };
      return (data.commits ?? []).map((c) => (c.commit?.message ?? "").split("\n")[0]!.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async download(asset: ReleaseAsset, file: string, timeoutMs: number): Promise<void> {
    const url = asset.url ?? asset.browser_download_url;
    if (!url) throw new Error(tr().system.update.noDownloadUrl(asset.name));
    const res = await this.request(url, "application/octet-stream", timeoutMs);
    if (!res.ok || !res.body) throw new Error(httpError(res, tr().system.update.downloadWhat));
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(file));
  }
}

function httpError(res: Response, what: string): string {
  const limited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
  if (limited) return tr().system.update.rateLimited(what);
  return tr().system.update.httpFailed(what, res.status);
}
