import { describe, expect, it } from "vitest";
import { gitMissing } from "../src/git/git.js";
import { installKind, platformTag } from "../src/util/platform.js";

describe("platform", () => {
  it("tags the platform like the release assets", () => {
    expect(platformTag({}, "win32", "x64")).toBe("win32-x64");
    expect(platformTag({}, "win32", "arm64")).toBe("win32-x64");
    expect(platformTag({}, "darwin", "arm64")).toBe("darwin-arm64");
    expect(platformTag({}, "darwin", "x64")).toBe("darwin-x64");
    expect(platformTag({}, "linux", "x64")).toBe("linux-x64");
    // the desktop shell knows best
    expect(platformTag({ FORGE_PLATFORM: "darwin-x64" }, "darwin", "arm64")).toBe("darwin-x64");
    expect(platformTag({ FORGE_PLATFORM: "kaputt" }, "linux", "x64")).toBe("linux-x64");
  });

  it("tells how to get git where FORGE does not ship it", () => {
    expect(gitMissing("darwin")).toContain("xcode-select --install");
    expect(gitMissing("linux")).toContain("sudo apt install git");
    expect(gitMissing("win32")).not.toContain("apt");
  });

  it("reads how FORGE was installed, null without (behave as before)", () => {
    expect(installKind({ FORGE_INSTALL_KIND: "appimage" })).toBe("appimage");
    expect(installKind({ FORGE_INSTALL_KIND: "msi" })).toBeNull();
    expect(installKind({})).toBeNull();
  });
});
