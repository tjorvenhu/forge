import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataDir, isInside, pathKey, sensitivePaths } from "../src/util/paths.js";

const root = path.parse(process.cwd()).root;

describe("pathKey / isInside", () => {
  it("keeps the separator of a root path", () => {
    expect(pathKey(root).length).toBe(root.length);
  });

  it("treats everything on a drive as inside its root", () => {
    expect(isInside(path.join(root, "Users", "x"), root)).toBe(true);
    expect(isInside(root, root)).toBe(true);
  });

  it("ignores trailing separators and stays exact for siblings", () => {
    const base = path.join(root, "work", "app");
    expect(isInside(path.join(base, "src"), base + path.sep)).toBe(true);
    expect(isInside(path.join(root, "work", "app-2"), base)).toBe(false);
    expect(isInside(path.join(root, "work"), base)).toBe(false);
  });
});

describe("platform paths", () => {
  it("keeps the data folder where each platform expects it", () => {
    expect(defaultDataDir({ APPDATA: "C:/Users/x/AppData/Roaming" }, "win32", "C:/Users/x")).toBe(path.join("C:/Users/x/AppData/Roaming", "forge"));
    expect(defaultDataDir({}, "darwin", "/Users/x")).toBe(path.join("/Users/x", "Library", "Application Support", "forge"));
    expect(defaultDataDir({}, "linux", "/home/x")).toBe(path.join("/home/x", ".config", "forge"));
    expect(defaultDataDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/x")).toBe(path.join("/cfg", "forge"));
  });

  it("compares paths case-insensitively on Windows and macOS only", () => {
    const p = path.join(root, "Work", "App");
    expect(pathKey(p, "win32")).toBe(pathKey(p, "win32").toLowerCase());
    expect(pathKey(p, "darwin")).toBe(pathKey(p, "darwin").toLowerCase());
    expect(pathKey(p, "linux")).toContain("App");
  });

  it("lists the credential and browser folders of each platform", () => {
    const mac = sensitivePaths("/Users/x", "darwin");
    expect(mac).toContain(path.join("/Users/x", "Library", "Keychains"));
    expect(mac).toContain(path.join("/Users/x", "Library", "Application Support", "Google", "Chrome"));
    expect(mac).toContain(path.join("/Users/x", ".ssh"));
    const linux = sensitivePaths("/home/x", "linux");
    expect(linux).toContain(path.join("/home/x", ".mozilla"));
    expect(linux).toContain(path.join("/home/x", ".local", "share", "keyrings"));
    expect(linux).toContain(path.join("/home/x", ".ssh"));
    expect(linux.some((p) => p.includes("AppData"))).toBe(false);
    expect(sensitivePaths("C:/Users/x", "win32")).toContain(path.join("C:/Users/x", ".ssh"));
  });
});
