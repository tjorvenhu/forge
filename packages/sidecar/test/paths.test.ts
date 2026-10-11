import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInside, pathKey } from "../src/util/paths.js";

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
