import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, fetchLatestVersion, parseVersion, readUpdateChannel } from "../src/claude/update.js";
import { tempDir } from "./helpers.js";

describe("Claude update check", () => {
  it("parses and compares CLI versions", () => {
    expect(parseVersion("2.1.296 (Claude Code)")).toBe("2.1.296");
    expect(parseVersion("kein Treffer")).toBeNull();
    expect(compareVersions("2.1.297", "2.1.296")).toBe(1);
    expect(compareVersions("2.10.0", "2.9.9")).toBe(1);
    expect(compareVersions("2.1.296", "2.1.296")).toBe(0);
    expect(compareVersions("2.1.287", "2.1.296")).toBe(-1);
  });

  it("follows the autoUpdatesChannel from the Claude settings", async () => {
    const t = tempDir();
    try {
      expect(await readUpdateChannel(t.dir)).toBe("latest");
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(path.join(t.dir, "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
      expect(await readUpdateChannel(t.dir)).toBe("stable");
    } finally {
      t.cleanup();
    }
  });

  it("reads the version from the release endpoint and reports HTTP errors", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => {
      urls.push(url);
      return new Response("2.1.300\n");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion("stable", ok)).toBe("2.1.300");
    expect(urls).toEqual(["https://downloads.claude.ai/claude-code-releases/stable"]);
    const fail = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLatestVersion("latest", fail)).rejects.toThrow(/HTTP 503/);
  });
});
