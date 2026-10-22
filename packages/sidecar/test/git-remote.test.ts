import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { initRepo, tempDir } from "./helpers.js";

const engine = new GitEngine();
let t: ReturnType<typeof tempDir>;

beforeEach(async () => {
  t = tempDir();
  mkdirSync(t.dir);
  await initRepo(t.dir);
});
afterEach(() => t.cleanup());

describe("setRemoteUrl", { timeout: 30_000 }, () => {
  it("adds origin, changes it and removes it", async () => {
    expect(await engine.remoteUrl(t.dir)).toBeNull();
    await engine.setRemoteUrl(t.dir, "https://github.com/vanturis/forge.git");
    expect(await engine.remoteUrl(t.dir)).toBe("https://github.com/vanturis/forge.git");
    await engine.setRemoteUrl(t.dir, " git@github.com:vanturis/forge.git ");
    expect(await engine.remoteUrl(t.dir)).toBe("git@github.com:vanturis/forge.git");
    await engine.setRemoteUrl(t.dir, null);
    expect(await engine.remoteUrl(t.dir)).toBeNull();
    await engine.setRemoteUrl(t.dir, null);
  });

  it("refuses a URL git would read as an option", async () => {
    await expect(engine.setRemoteUrl(t.dir, "--upload-pack=touch x")).rejects.toBeInstanceOf(ForgeError);
    expect(await engine.remoteUrl(t.dir)).toBeNull();
  });
});
