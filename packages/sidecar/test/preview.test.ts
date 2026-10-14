import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserCandidates, findBrowser, NO_BROWSER, sweepProfiles } from "../src/preview/browser.js";
import { parseKey } from "../src/preview/page.js";
import { formatLogs, logSummary, PreviewService, stepProblem } from "../src/preview/preview.js";
import { isLocalUrl, previewUrl } from "../src/preview/url.js";
import { projectTools } from "../src/sessions/forge-tools.js";
import type { DevEnvironment } from "../src/devtools/environment.js";
import type { KnowledgeStore } from "../src/knowledge/knowledge.js";
import type { ToolOutput } from "../src/claude/runtime.js";
import { tempDir } from "./helpers.js";

describe("preview addresses", () => {
  it("allows only http(s) on this machine", () => {
    expect(previewUrl({ url: "http://localhost:5173" })).toBe("http://localhost:5173/");
    expect(previewUrl({ url: "https://127.0.0.1:8443/app" })).toBe("https://127.0.0.1:8443/app");
    expect(previewUrl({ url: "http://[::1]:3000/" })).toBe("http://[::1]:3000/");
    expect(() => previewUrl({ url: "https://example.com" })).toThrow(/nur Adressen auf diesem Rechner.*example\.com/);
    expect(() => previewUrl({ url: "http://192.168.1.10:3000" })).toThrow(/nicht 192\.168\.1\.10/);
    expect(() => previewUrl({ url: "file:///C:/Windows/win.ini" })).toThrow(/nur http- und https-Adressen/);
    expect(() => previewUrl({ url: "localhost:3000" })).toThrow(/http- und https/);
    expect(() => previewUrl({ url: "nicht da" })).toThrow(/keine gültige Adresse/);
    expect(() => previewUrl({})).toThrow(/Keine Adresse/);
  });

  it("resolves a path against the dev server and keeps it local", () => {
    expect(previewUrl({ base: "http://localhost:3000", path: "/settings?tab=a" })).toBe("http://localhost:3000/settings?tab=a");
    expect(previewUrl({ url: "http://localhost:3000/a/b", path: "c" })).toBe("http://localhost:3000/a/c");
    expect(previewUrl({ url: "http://localhost:4000", base: "http://localhost:3000" })).toBe("http://localhost:4000/");
    expect(() => previewUrl({ base: "http://localhost:3000", path: "//evil.example/x" })).toThrow(/evil\.example/);
    expect(() => previewUrl({ base: "http://localhost:3000", path: "https://evil.example" })).toThrow(/evil\.example/);
  });

  it("tells local documents from the rest", () => {
    expect(isLocalUrl("http://LOCALHOST:1/x")).toBe(true);
    expect(isLocalUrl("https://accounts.google.com/")).toBe(false);
    expect(isLocalUrl("about:blank")).toBe(false);
    expect(isLocalUrl("kaputt")).toBe(false);
  });
});

describe("browser search", () => {
  const env = { "ProgramFiles(x86)": "C:\\PF86", ProgramFiles: "C:\\PF", ProgramW6432: "C:\\PF", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };

  it("prefers Edge and falls back to Chrome on Windows", () => {
    const list = browserCandidates(env, "win32");
    expect(list[0]).toBe(path.win32.join("C:\\PF86", "Microsoft", "Edge", "Application", "msedge.exe"));
    expect(list.filter((p) => p.endsWith("msedge.exe"))).toHaveLength(3);
    const chrome = path.win32.join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe");
    expect(findBrowser(env, "win32", (p) => p === chrome)).toBe(chrome);
    expect(findBrowser(env, "win32", (p) => p.endsWith("msedge.exe") || p === chrome)).toMatch(/msedge\.exe$/);
    expect(findBrowser(env, "win32", () => false)).toBeNull();
  });

  it("knows the usual places on other systems", () => {
    expect(browserCandidates({}, "darwin")[0]).toMatch(/Microsoft Edge/);
    expect(browserCandidates({}, "linux")).toContain("/usr/bin/chromium");
  });

  it("sweeps empty and stale preview profiles, not fresh ones", () => {
    const t = tempDir();
    try {
      const make = (name: string, files: boolean) => {
        const dir = path.join(t.dir, name);
        mkdirSync(dir, { recursive: true });
        if (files) writeFileSync(path.join(dir, "lockfile"), "");
        return dir;
      };
      const empty = make("forge-preview-leer", false);
      const fresh = make("forge-preview-frisch", true);
      const stale = make("forge-preview-alt", true);
      const other = make("anderes", false);
      const old = new Date(Date.now() - 24 * 60 * 60_000);
      utimesSync(stale, old, old);
      sweepProfiles(t.dir);
      expect([empty, fresh, stale, other].map((d) => existsSync(d))).toEqual([false, true, false, true]);
    } finally {
      t.cleanup();
    }
  });

  it("explains a missing browser and a missing dev server in German", async () => {
    const none = new PreviewService({ devServer: async () => ({ status: "stopped", url: null }), findBrowser: () => null });
    await expect(none.screenshot("p", {})).rejects.toThrow(NO_BROWSER);
  });
});

describe("preview helpers", () => {
  it("parses keys with modifiers", () => {
    expect(parseKey("Enter")).toMatchObject({ key: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    expect(parseKey("arrowdown")).toMatchObject({ key: "ArrowDown", keyCode: 40, text: undefined });
    expect(parseKey("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
    expect(parseKey("Control+a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, text: undefined, modifiers: 2 });
    expect(parseKey("7")).toMatchObject({ code: "Digit7", text: "7" });
    expect(parseKey("Space")).toMatchObject({ key: " ", text: " " });
    expect(parseKey("Hyper+a")).toBeNull();
    expect(parseKey("Weiter")).toBeNull();
  });

  it("checks steps before running them", () => {
    expect(stepProblem({ action: "click" })).toMatch(/selector/);
    expect(stepProblem({ action: "type", selector: "#q" })).toMatch(/text/);
    expect(stepProblem({ action: "type", selector: "#q", clear: true })).toBeNull();
    expect(stepProblem({ action: "press" })).toMatch(/key/);
    expect(stepProblem({ action: "wait" })).toMatch(/ms oder selector/);
    expect(stepProblem({ action: "wait", ms: 0 })).toBeNull();
  });

  it("summarizes and lists what the page logged", () => {
    const logs = [
      { kind: "console" as const, level: "error", text: "kaputt" },
      { kind: "console" as const, level: "warning", text: "veraltet" },
      { kind: "console" as const, level: "log", text: "hallo" },
      { kind: "exception" as const, level: "error", text: "TypeError: x is undefined" },
      { kind: "network" as const, level: "404", text: "GET http://localhost:3000/api → 404 Not Found" },
    ];
    expect(logSummary(logs)).toBe("1 Fehler, 1 Warnung, 1 weitere Meldung; 1 unbehandelte Ausnahme; 1 fehlgeschlagene Anfrage");
    expect(logSummary([])).toBe("keine Meldungen");
    expect(formatLogs(logs)).toEqual([
      "Unbehandelte Ausnahmen:",
      "- TypeError: x is undefined",
      "Fehler und Warnungen der Konsole:",
      "- [error] kaputt",
      "- [warning] veraltet",
      "Fehlgeschlagene Anfragen:",
      "- GET http://localhost:3000/api → 404 Not Found",
      "Weitere Konsolenmeldungen:",
      "- [log] hallo",
    ]);
  });
});

describe("preview tools in a session", () => {
  const knowledge = { owner: (id: string) => id, index: () => ({ lines: [], total: 0 }), dir: () => "" } as unknown as KnowledgeStore;
  const rec = { id: "s1", projectId: "p1", cwd: "C:\\p" } as Parameters<typeof projectTools>[0];

  it("are offered with the preview service and explained in the context", () => {
    const preview = new PreviewService({ devServer: async () => ({ status: "stopped", url: null }) });
    const { tools, context } = projectTools(rec, { knowledge, dev: {} as DevEnvironment, preview });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["preview_screenshot", "preview_console", "preview_interact"]));
    expect(tools.find((t) => t.name === "preview_screenshot")!.autoAllow).toBe(true);
    expect(tools.find((t) => t.name === "preview_console")!.autoAllow).toBe(true);
    expect(tools.find((t) => t.name === "preview_interact")!.autoAllow).toBe(false);
    expect(context.join("\n")).toMatch(/preview_screenshot/);
  });

  it("are missing without it", () => {
    const { tools, context } = projectTools(rec, { knowledge, dev: {} as DevEnvironment });
    expect(tools.map((t) => t.name).filter((n) => n.startsWith("preview_"))).toEqual([]);
    expect(context.join("\n")).not.toMatch(/preview_/);
  });

  it("refuse broken steps before a browser starts", async () => {
    let launched = false;
    const preview = new PreviewService({
      devServer: async () => ({ status: "running", url: "http://localhost:1" }),
      findBrowser: () => {
        launched = true;
        return null;
      },
    });
    const { tools } = projectTools(rec, { knowledge, dev: {} as DevEnvironment, preview });
    await expect(tools.find((t) => t.name === "preview_interact")!.run({ steps: [{ action: "click" }, { action: "press" }] })).rejects.toThrow(
      "Schritt 1: click braucht selector. Schritt 2: press braucht key.",
    );
    expect(launched).toBe(false);
  });
});

const browser = findBrowser();

/** Needs Edge or Chrome on the machine; starts it headless against a small local page. */
describe.skipIf(!browser)("preview in a real browser", () => {
  let server: Server;
  let base = "";
  let devUrl: string | null = null;
  let preview: PreviewService;

  const PAGE = `<!doctype html><html><head><title>Testseite</title></head><body style="height:3000px">
<h1 id="h">Hallo</h1><input id="q"><button id="b" onclick="document.title = 'Geklickt: ' + document.getElementById('q').value">Los</button>
<form id="f" onsubmit="event.preventDefault(); document.title = 'Gesendet'"><input id="enter"></form>
<script>console.error("absichtlich kaputt"); console.warn("veraltet"); console.log("hallo", 42); fetch("/fehlt"); setTimeout(() => { throw new Error("Boom") }, 0);</script>
</body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      } else if (req.url === "/weg") {
        res.writeHead(302, { location: "https://example.com/" });
        res.end();
      } else {
        res.writeHead(404);
        res.end("nicht da");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    preview = new PreviewService({ devServer: async () => ({ status: devUrl ? "running" : "stopped", url: devUrl }) });
  });

  afterAll(async () => {
    await preview?.closeAll();
    await new Promise((r) => server?.close(r));
  });

  it("says when no dev server runs", async () => {
    devUrl = null;
    await expect(preview.screenshot("x", {})).rejects.toThrow(/kein Dev-Server/);
  }, 30_000);

  it("takes a screenshot of the dev server and reads its console", async () => {
    devUrl = base;
    const shot = (await preview.screenshot("x", { width: 800, height: 600 })) as ToolOutput;
    expect(shot.text).toContain("Titel: Testseite");
    expect(shot.text).toContain(`Adresse: ${base}/`);
    expect(shot.text).toContain("HTTP-Status: 200");
    expect(shot.text).toMatch(/^Screenshot: 800x600 JPEG$/m);
    expect(shot.images?.[0]?.mimeType).toBe("image/jpeg");
    expect(Buffer.from(shot.images![0]!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");

    const log = await preview.console("x", {});
    expect(log).toContain("Meldungen der zuletzt geöffneten Seite");
    expect(log).toContain("[error] absichtlich kaputt");
    expect(log).toContain("[warning] veraltet");
    expect(log).toContain("[log] hallo 42");
    expect(log).toMatch(/Error: Boom/);
    expect(log).toMatch(/GET .*\/fehlt → 404/);

    const full = (await preview.screenshot("x", { fullPage: true })) as ToolOutput;
    expect(full.text).toMatch(/^Screenshot: \d+x1568 JPEG, ganze Seite \(verkleinert\)$/m);
  }, 60_000);

  it("clicks, types and presses keys", async () => {
    const r = (await preview.interact("x", {
      path: "/",
      steps: [
        { action: "type", selector: "#q", text: "Welt" },
        { action: "click", selector: "#b" },
        { action: "wait", selector: "#h" },
      ],
    })) as ToolOutput;
    expect(r.text).toContain("Alle 3 Schritte ausgeführt.");
    expect(r.text).toContain("Titel: Geklickt: Welt");
    expect(r.images).toHaveLength(1);
    const after = (await preview.interact("x", { steps: [{ action: "type", selector: "#enter", text: "x" }, { action: "press", key: "Enter" }], screenshot: false })) as ToolOutput;
    expect(after.text).toContain("Titel: Gesendet");
    expect(after.images).toBeUndefined();
    const replaced = (await preview.interact("x", { steps: [{ action: "type", selector: "#q", text: "Neu", clear: true }, { action: "click", selector: "#b" }], screenshot: false })) as ToolOutput;
    expect(replaced.text).toContain("Titel: Geklickt: Neu");

    const failed = (await preview.interact("x", { steps: [{ action: "click", selector: "#gibtsnicht" }, { action: "wait", ms: 1 }], stepMs: 300 })) as ToolOutput;
    expect(failed.text).toMatch(/1\. click #gibtsnicht: Fehler: Kein sichtbares Element/);
    expect(failed.text).toContain("Abgebrochen nach Schritt 1 von 2.");
    expect(failed.images).toHaveLength(1);
    const bad = (await preview.interact("x", { steps: [{ action: "wait", selector: "##" }], screenshot: false })) as ToolOutput;
    expect(bad.text).toContain("Ungültiger CSS-Selektor: ##");
  }, 60_000);

  it("does not follow a redirect off this machine", async () => {
    await expect(preview.screenshot("x", { path: "/weg" })).rejects.toThrow(/außerhalb dieses Rechners/);
  }, 60_000);
});
