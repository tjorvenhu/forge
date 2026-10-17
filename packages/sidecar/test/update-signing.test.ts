import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubReleases } from "../src/update/github-releases.js";
import { verifySignature } from "../src/update/signature.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("update signatures", () => {
  it("verifies what scripts/sign-update.mjs signs, and nothing else", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-sign-"));
    dirs.push(dir);
    const keys = generateKeyPairSync("ed25519");
    const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const file = path.join(dir, "FORGE_0.1.70_update_x.zip");
    writeFileSync(file, "inhalt");
    execFileSync(process.execPath, [path.resolve(__dirname, "../../../scripts/sign-update.mjs"), file], {
      env: { ...process.env, FORGE_UPDATE_SIGNING_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    });
    const sig = readFileSync(`${file}.sig`, "utf8");
    const sha = createHash("sha256").update("inhalt").digest("hex");
    expect(verifySignature("FORGE_0.1.70_update_x.zip", sha, sig, pub)).toBe(true);
    // Bound to the name and the content, and to the right key.
    expect(verifySignature("FORGE_0.1.71_update_x.zip", sha, sig, pub)).toBe(false);
    expect(verifySignature("FORGE_0.1.70_update_x.zip", "0".repeat(64), sig, pub)).toBe(false);
    expect(verifySignature("FORGE_0.1.70_update_x.zip", sha, sig)).toBe(false);
    expect(verifySignature("FORGE_0.1.70_update_x.zip", sha, "kaputt", pub)).toBe(false);
  });

  it("refuses to sign without a key", () => {
    expect(() =>
      execFileSync(process.execPath, [path.resolve(__dirname, "../../../scripts/sign-update.mjs"), "x"], { env: { ...process.env, FORGE_UPDATE_SIGNING_KEY: "" }, stdio: "pipe" }),
    ).toThrow();
  });
});

describe("GitHubReleases", () => {
  function fake(statuses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ url, auth: headers.Authorization ?? null });
      const next = statuses.shift()!;
      return new Response(next.body === undefined ? null : typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status, headers: next.headers });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  it("asks anonymously and uses the gh login only when GitHub refuses", async () => {
    const open = fake([{ status: 200, body: [{ tag_name: "v0.1.70" }] }]);
    let asked = 0;
    const token = async () => {
      asked++;
      return "geheim";
    };
    expect(await new GitHubReleases("o/r", token, open.fetchFn).releases()).toEqual([{ tag_name: "v0.1.70" }]);
    expect(open.seen).toEqual([{ url: "https://api.github.com/repos/o/r/releases?per_page=100", auth: null }]);
    expect(asked).toBe(0);

    // A private repository answers 404 without a login.
    const priv = fake([{ status: 404 }, { status: 200, body: [] }]);
    expect(await new GitHubReleases("o/r", token, priv.fetchFn).releases()).toEqual([]);
    expect(priv.seen.map((s) => s.auth)).toEqual([null, "Bearer geheim"]);

    const none = fake([{ status: 404 }]);
    expect(await new GitHubReleases("o/r", async () => null, none.fetchFn).releases()).toBeNull();
  });

  it("explains the rate limit for requests without a login", async () => {
    const limited = fake([{ status: 403, headers: { "x-ratelimit-remaining": "0" } }]);
    await expect(new GitHubReleases("o/r", async () => null, limited.fetchFn).releases()).rejects.toThrow(/begrenzt Anfragen ohne Anmeldung/);
  });

  it("downloads an asset over its API address and reads commit subjects", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-gh-"));
    dirs.push(dir);
    const f = fake([{ status: 200, body: "MZ datei" }, { status: 200, body: { commits: [{ commit: { message: "feat: A\n\nText" } }, { commit: { message: "fix: B" } }] } }]);
    const gh = new GitHubReleases("o/r", async () => null, f.fetchFn);
    const file = path.join(dir, "a.zip");
    await gh.download({ name: "a.zip", url: "https://api.github.com/repos/o/r/releases/assets/1" }, file, 5_000);
    expect(readFileSync(file, "utf8")).toBe("MZ datei");
    expect(await gh.commits("v0.1.1", "v0.1.2")).toEqual(["feat: A", "fix: B"]);
    expect(f.seen[1]!.url).toBe("https://api.github.com/repos/o/r/compare/v0.1.1...v0.1.2");
  });
});
