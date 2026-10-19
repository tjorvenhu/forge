import { describe, expect, it } from "vitest";
import { detectPlatform, formatShortcuts, hasPrimaryModifier, nativePath, pathInside, platform, withPlatformShortcuts } from "./platform";

describe("detectPlatform", () => {
  it("tells the three WebViews apart and falls back to Windows", () => {
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0" })).toBe("windows");
    expect(detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15" })).toBe("macos");
    expect(detectPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15" })).toBe("linux");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe("windows");
    expect(detectPlatform(undefined)).toBe("windows");
  });

  it("is Windows in the tests, whatever system runs them", () => {
    expect(platform).toBe("windows");
  });
});

describe("hasPrimaryModifier", () => {
  const ctrl = { ctrlKey: true, metaKey: false };
  const meta = { ctrlKey: false, metaKey: true };
  it("is Cmd on the Mac, Ctrl on Linux, both on Windows as before", () => {
    expect([hasPrimaryModifier(ctrl, "macos"), hasPrimaryModifier(meta, "macos")]).toEqual([false, true]);
    expect([hasPrimaryModifier(ctrl, "linux"), hasPrimaryModifier(meta, "linux")]).toEqual([true, false]);
    expect([hasPrimaryModifier(ctrl, "windows"), hasPrimaryModifier(meta, "windows")]).toEqual([true, true]);
  });
});

describe("formatShortcuts", () => {
  it("leaves the texts alone on Windows and Linux", () => {
    for (const p of ["windows", "linux"] as const) {
      expect(formatShortcuts("Seitenleiste einblenden (Strg+Umschalt+E)", p)).toBe("Seitenleiste einblenden (Strg+Umschalt+E)");
      expect(formatShortcuts("Strg K", p)).toBe("Strg K");
    }
  });

  it("writes Apple's symbols in Apple's order on the Mac", () => {
    expect(formatShortcuts("Seitenleiste einblenden (Strg+Umschalt+E)", "macos")).toBe("Seitenleiste einblenden (⇧⌘E)");
    expect(formatShortcuts("Show sidebar (Ctrl+Shift+E)", "macos")).toBe("Show sidebar (⇧⌘E)");
    expect(formatShortcuts("Suchen und Befehle (Strg+K)", "macos")).toBe("Suchen und Befehle (⌘K)");
    expect(formatShortcuts("Strg K", "macos")).toBe("⌘K");
    expect(formatShortcuts("Strg+Enter sendet, Umschalt+Enter macht eine neue Zeile.", "macos")).toBe("⌘Enter sendet, ⇧Enter macht eine neue Zeile.");
    expect(formatShortcuts("Alt+Shift+F12", "macos")).toBe("⌥⇧F12");
  });

  it("keeps Control before Tab and leaves prose and clicks alone", () => {
    expect(formatShortcuts("Strg+Tab", "macos")).toBe("⌃Tab");
    expect(formatShortcuts("Umschalt+Klick öffnet es daneben.", "macos")).toBe("Umschalt+Klick öffnet es daneben.");
    expect(formatShortcuts("Alt 2 und Shift happens", "macos")).toBe("Alt 2 und Shift happens");
    expect(formatShortcuts("wie ⌃B im Terminal", "macos")).toBe("wie ⌃B im Terminal");
  });
});

describe("withPlatformShortcuts", () => {
  const messages = { a: "Panel (Strg+J)", nested: { key: (k: string) => `Strg+${k}`, count: (n: number) => n }, list: ["Strg+V"] };

  it("returns the very same tree off the Mac", () => {
    expect(withPlatformShortcuts(messages, "windows")).toBe(messages);
    expect(withPlatformShortcuts(messages, "linux")).toBe(messages);
  });

  it("formats strings and the results of functions on the Mac", () => {
    const mac = withPlatformShortcuts(messages, "macos");
    expect(mac.a).toBe("Panel (⌘J)");
    expect(mac.nested.key("Z")).toBe("⌘Z");
    expect(mac.nested.count(3)).toBe(3);
    expect(mac.list).toEqual(["⌘V"]);
  });
});

describe("paths", () => {
  it("finds the part inside a folder, without case where the file system ignores it", () => {
    expect(pathInside("C:\\code\\Shop\\src\\a.ts", "c:/code/shop", "windows")).toBe("src/a.ts");
    expect(pathInside("/Users/anna/Shop/src/a.ts", "/Users/anna/shop", "macos")).toBe("src/a.ts");
    expect(pathInside("/home/anna/Shop/src/a.ts", "/home/anna/shop", "linux")).toBeNull();
    expect(pathInside("/home/anna/shop/src/a.ts", "/home/anna/shop/", "linux")).toBe("src/a.ts");
    expect(pathInside("/home/anna/shop", "/home/anna/shop", "linux")).toBe("");
    expect(pathInside("/home/anna/shopping/a.ts", "/home/anna/shop", "linux")).toBeNull();
  });

  it("uses backslashes for the file manager only on Windows", () => {
    expect(nativePath("C:/code/shop/a.ts", "windows")).toBe("C:\\code\\shop\\a.ts");
    expect(nativePath("/Users/anna/a.ts", "macos")).toBe("/Users/anna/a.ts");
    expect(nativePath("/home/anna/a.ts", "linux")).toBe("/home/anna/a.ts");
  });
});
