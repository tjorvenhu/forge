import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent, SessionEventBody, UiCompare } from "@forge/protocol";
import { comparePage, editedFile, isUiFile, UiCompareService } from "../src/preview/ui-compare.js";
import type { Capture } from "../src/preview/preview.js";
import { tempDir } from "./helpers.js";

const SHOP = path.resolve("/work/shop");
const JPEG = Buffer.from("jpeg").toString("base64");

describe("UiCompareService", () => {
  let tmp: ReturnType<typeof tempDir>;
  let dir: string;
  let recorded: Array<{ id: string; body: SessionEventBody }>;
  let emitted: UiCompare[];
  let captures: string[];
  let tracked: Array<Promise<unknown>>;
  let dev: { status: string; url: string | null };
  let enabled: boolean;
  let browser: boolean;
  let fail: string | null;
  let viewed: string | null;
  let now: number;

  const make = () =>
    new UiCompareService({
      dir,
      enabled: () => enabled,
      session: (id) => (id === "s1" ? { projectId: "p1", cwd: SHOP } : null),
      devServer: async () => dev,
      hasBrowser: () => browser,
      lastViewed: () => viewed,
      capture: async (_projectId, url): Promise<Capture> => {
        captures.push(url);
        if (fail) throw new Error(fail);
        return { data: JPEG, mimeType: "image/jpeg", width: 1280, height: 800, cut: false, url };
      },
      record: (id, body) => recorded.push({ id, body }),
      emit: (e: ServerEvent) => {
        if (e.event === "uiCompare.updated") emitted.push(e.payload);
      },
      track: (p) => tracked.push(p),
      settleMs: 0,
      now: () => now,
    });
  const settle = async () => {
    while (tracked.length) await Promise.all(tracked.splice(0));
  };

  beforeEach(() => {
    tmp = tempDir("forge-uicompare-");
    dir = path.join(tmp.dir, "ui-compare");
    recorded = [];
    emitted = [];
    captures = [];
    tracked = [];
    dev = { status: "running", url: "http://localhost:5173/" };
    enabled = true;
    browser = true;
    fail = null;
    viewed = null;
    now = Date.parse("2026-10-16T10:00:00.000Z");
  });
  afterEach(() => tmp.cleanup());

  it("compares before and after when the turn edits UI files", async () => {
    const ui = make();
    viewed = "http://localhost:5173/cart";
    ui.turnStarted("s1");
    ui.toolUsed("s1", "Edit", { file_path: path.join(SHOP, "src", "Cart.tsx") });
    ui.toolUsed("s1", "Write", { file_path: "src/cart.ts" });
    ui.toolUsed("s1", "Read", { file_path: "src/App.css" });
    ui.turnEnded("s1");
    await settle();

    expect(captures).toEqual(["http://localhost:5173/cart", "http://localhost:5173/cart"]);
    expect(recorded).toHaveLength(1);
    const body = recorded[0]!.body;
    expect(body).toMatchObject({ type: "ui.compare", url: "http://localhost:5173/cart", files: ["src/Cart.tsx"] });
    const id = (body as Extract<SessionEventBody, { type: "ui.compare" }>).compareId;
    expect(emitted.map((c) => c.status)).toEqual(["capturing", "ready"]);

    const c = await ui.get("s1", id);
    expect(c.status).toBe("ready");
    expect(existsSync(c.before.path) && existsSync(c.after!.path)).toBe(true);
    expect(await ui.image("s1", id, "after")).toEqual({ mediaType: "image/jpeg", base64: JPEG });
    await expect(ui.get("s2", id)).rejects.toThrow(/nicht mehr vorhanden/);
    expect((await ui.latest({ sessionId: "s1" }))?.id).toBe(id);
    expect(await ui.latest({ projectId: "p2" })).toBeNull();
  });

  it("throws the before image away when no UI file changed", async () => {
    const ui = make();
    ui.turnStarted("s1");
    ui.toolUsed("s1", "Edit", { file_path: "src/cart.ts" });
    ui.turnEnded("s1");
    await settle();
    expect(captures).toHaveLength(1);
    expect(recorded).toEqual([]);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("does nothing without a running dev server, a browser or with the setting off", async () => {
    for (const setup of [() => (dev = { status: "stopped", url: null }), () => (browser = false), () => (enabled = false)]) {
      setup();
      const ui = make();
      ui.turnStarted("s1");
      ui.toolUsed("s1", "Edit", { file_path: "src/App.tsx" });
      ui.turnEnded("s1");
      await settle();
      dev = { status: "running", url: "http://localhost:5173/" };
      browser = true;
      enabled = true;
    }
    expect(captures).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("keeps the first before image when a message joins the running turn, and drops it when the process ends", async () => {
    const ui = make();
    ui.turnStarted("s1");
    ui.turnStarted("s1");
    ui.toolUsed("s1", "Edit", { file_path: "src/App.tsx" });
    ui.drop("s1");
    ui.turnEnded("s1");
    await settle();
    expect(captures).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it("reports a failed after image and takes it again", async () => {
    const ui = make();
    ui.turnStarted("s1");
    ui.toolUsed("s1", "MultiEdit", { file_path: "src/styles.scss" });
    await settle();
    fail = "Unter http://localhost:5173/ antwortet nichts";
    ui.turnEnded("s1");
    await settle();
    const id = (recorded[0]!.body as Extract<SessionEventBody, { type: "ui.compare" }>).compareId;
    expect(await ui.get("s1", id)).toMatchObject({ status: "failed", after: null, error: "Unter http://localhost:5173/ antwortet nichts" });
    await expect(ui.image("s1", id, "after")).rejects.toThrow(/gibt es noch nicht/);

    fail = null;
    expect((await ui.retake("s1", id)).status).toBe("capturing");
    await settle();
    expect((await ui.get("s1", id)).status).toBe("ready");
    expect(emitted.at(-1)?.status).toBe("ready");
  });

  it("prunes comparisons older than 14 days and before images left behind", async () => {
    const ui = make();
    ui.turnStarted("s1");
    ui.toolUsed("s1", "Edit", { file_path: "src/App.tsx" });
    ui.turnEnded("s1");
    await settle();
    const orphan = path.join(dir, "0-orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, "before.jpg"), "x");
    const old = new Date(now - 7 * 60 * 60_000);
    utimesSync(orphan, old, old);
    await ui.prune();
    expect(readdirSync(dir)).toHaveLength(1);
    now += 15 * 24 * 60 * 60_000;
    await ui.prune();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("ui-compare helpers", () => {
  it("knows UI files", () => {
    expect(["a.tsx", "b.JSX", "c.vue", "d.svelte", "e.css", "f.scss", "g.html", "h.astro"].every(isUiFile)).toBe(true);
    expect(["a.ts", "b.json", "README.md", "Dockerfile"].some(isUiFile)).toBe(false);
  });

  it("takes files of edit tools inside the session's folder only", () => {
    const cwd = path.resolve("/work/shop");
    expect(editedFile(cwd, "Edit", { file_path: path.join(cwd, "src", "App.tsx") })).toBe("src/App.tsx");
    expect(editedFile(cwd, "Write", { file_path: "src/index.css" })).toBe("src/index.css");
    expect(editedFile(cwd, "Edit", { file_path: path.resolve("/other/App.tsx") })).toBeNull();
    expect(editedFile(cwd, "Read", { file_path: "src/App.tsx" })).toBeNull();
    expect(editedFile(cwd, "Bash", { command: "sed -i s/a/b/ src/App.tsx" })).toBeNull();
  });

  it("shows the page Claude looked at last when it is local, else the dev server", () => {
    expect(comparePage("http://localhost:3000/settings", "http://localhost:3000/")).toBe("http://localhost:3000/settings");
    expect(comparePage("https://example.com/", "http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(comparePage(null, "http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
  });
});
