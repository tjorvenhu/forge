import { describe, expect, it } from "vitest";
import { countInstallerDownloads } from "./downloads";

describe("installer downloads", () => {
  it("counts only the full installers, not updates, signatures or markers", () => {
    const releases = [
      {
        assets: [
          { name: "FORGE_0.1.90_x64-setup.exe", download_count: 7 },
          { name: "FORGE_0.1.90_x64-setup.exe.sig", download_count: 3 },
          { name: "FORGE_0.1.90_x64-setup.node-24_git-2.runtime", download_count: 3 },
          { name: "FORGE_0.1.90_update_node-24_git-2.zip", download_count: 40 },
        ],
      },
      { assets: [{ name: "FORGE_0.1.81_node-24.21.0_git-2.56.0.2_gh-2.102.0_python-3.14.8_x64-setup.exe", download_count: 5 }] },
      {},
    ];
    expect(countInstallerDownloads(releases)).toBe(12);
  });
});
