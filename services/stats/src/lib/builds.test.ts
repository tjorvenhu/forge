import { describe, expect, it } from "vitest";
import { detectOs, findBuilds } from "./builds";

const url = (name: string) => `https://github.com/vanturis/forge/releases/download/x/${name}`;

describe("download builds", () => {
  it("takes the newest release that has builds for the system, skipping one without", () => {
    const builds = findBuilds([
      { tag_name: "v0.1.130", assets: [{ name: "FORGE_0.1.130_update_node.zip", browser_download_url: url("a") }] },
      {
        tag_name: "v0.1.129",
        assets: [
          { name: "FORGE_0.1.129_darwin-arm64.dmg", browser_download_url: url("arm.dmg") },
          { name: "FORGE_0.1.129_darwin-arm64.app.tar.gz", browser_download_url: url("arm.tgz") },
          { name: "FORGE_0.1.129_linux-x64.deb", browser_download_url: url("x.deb") },
        ],
      },
      { tag_name: "v0.1.128", assets: [{ name: "FORGE_0.1.128_linux-x64.AppImage", browser_download_url: url("old.AppImage") }] },
    ]);
    expect(builds.macos).toEqual({ version: "0.1.129", files: [{ label: "Apple silicon (.dmg)", url: url("arm.dmg") }] });
    expect(builds.linux).toEqual({ version: "0.1.129", files: [{ label: "Debian, Ubuntu (.deb)", url: url("x.deb") }] });
    expect(findBuilds([{ tag_name: "v1", assets: [{ name: "FORGE_1_x64-setup.exe" }] }])).toEqual({ macos: null, linux: null });
  });

  it("skips dev pre-releases", () => {
    const builds = findBuilds([
      { tag_name: "v0.1.131", prerelease: true, assets: [{ name: "FORGE_0.1.131_darwin-arm64.dmg", browser_download_url: url("dev.dmg") }] },
      { tag_name: "v0.1.130", assets: [{ name: "FORGE_0.1.130_darwin-arm64.dmg", browser_download_url: url("stable.dmg") }] },
    ]);
    expect(builds.macos).toEqual({ version: "0.1.130", files: [{ label: "Apple silicon (.dmg)", url: url("stable.dmg") }] });
  });

  it("recognises the system from the client hint or the user agent", () => {
    expect(detectOs('"Windows"', null)).toBe("windows");
    expect(detectOs('"macOS"', "anything")).toBe("macos");
    expect(detectOs(null, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("macos");
    expect(detectOs(null, "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("linux");
    expect(detectOs(null, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("windows");
    expect(detectOs(null, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile")).toBeNull();
    expect(detectOs(null, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBeNull();
    expect(detectOs(null, null)).toBeNull();
  });
});
