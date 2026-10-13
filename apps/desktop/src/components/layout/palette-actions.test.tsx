import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PolicyRuleId, Settings, type ProjectWithStatus, type Session } from "@forge/protocol";
import { DEV_TOOLS_SECTIONS, EXTENSIONS_TABS, PROJECT_SETTINGS_SECTIONS, SETTINGS_SECTIONS, SKILLS_TABS, WORKSPACE_TABS, useUi } from "@/stores/ui";
import { TAG_INFO } from "@/components/workspace/ProjectSettingsTab";
import { buildActions, UNLISTED_SETTINGS, type ActionContext } from "./palette-actions";
import { crawlFiles } from "./palette-sources";
import { rank } from "./CommandPalette";
import { NAV } from "./nav";
import { keys } from "@/lib/queries";

const settingKeys = Object.keys(Settings.shape) as Array<keyof typeof Settings.shape>;
const booleanSettings = settingKeys.filter((k) => Settings.shape[k].def.type === "boolean");

const settings = {
  ...Object.fromEntries(settingKeys.map((k) => [k, booleanSettings.includes(k) ? false : null])),
  defaultProfile: "balanced",
  disabledPolicyRules: [],
} as unknown as Settings;

const project = {
  id: "p1",
  name: "Forge",
  path: "C:/forge",
  parentId: null,
  gitEnabled: true,
  exists: true,
  profile: "balanced",
  tags: [],
  technologies: [],
  git: { isRepo: true, branch: "feature/x", remoteUrl: "https://github.com/a/forge.git", ahead: 1, behind: 0, changedCount: 2 },
} as unknown as ProjectWithStatus;

const session = { id: "s1", projectId: "p1", title: "Test", model: null, effort: null, profile: "balanced", permissionMode: "acceptEdits", status: "idle", live: true } as unknown as Session;

/** Everything switched on that can show entries, so every area of FORGE has to appear. */
function fullContext(): ActionContext {
  const qc = new QueryClient();
  qc.setQueryData(keys.appUpdate, { currentVersion: "0.1.1", phase: "ready", latest: { version: "0.1.2", tag: "v0.1.2", notes: "", since: "0.1.1", publishedAt: null, size: null, kind: "patch", via: null }, autoInstall: false, installerPath: "C:/tmp/u.zip", installable: true, checkedAt: null, message: null });
  return {
    qc,
    project,
    root: project,
    session,
    settings,
    models: [{ value: "opus", displayName: "Opus", description: "" }],
    devServer: { status: "stopped", effectiveCommand: "pnpm dev" } as ActionContext["devServer"],
    testDb: { status: "stopped" } as ActionContext["testDb"],
    phone: { enabled: false, registration: "registered" } as ActionContext["phone"],
    remote: { enabled: false, sessions: [] },
    githubConnected: true,
    openDialog: () => {},
  };
}

function missing(prefix: string, values: readonly string[], ids: Set<string>) {
  return values.filter((v) => !ids.has(`${prefix}${v}`));
}

describe("command palette covers all of FORGE", () => {
  const entries = buildActions(fullContext());
  const ids = new Set(entries.map((e) => e.id));
  const hint = (what: string, where: string) => `Neu: ${what} ohne Eintrag in der Befehlspalette. Bitte in ${where} ergänzen.`;

  it("has an entry for every settings section", () => {
    expect(missing("settings-", SETTINGS_SECTIONS, ids), hint("Einstellungsbereich", "buildActions (palette-actions.tsx)")).toEqual([]);
  });

  it("has an entry for every workspace tab", () => {
    expect(missing("tab-", WORKSPACE_TABS, ids), hint("Workspace-Tab", "TAB_ENTRIES (palette-actions.tsx)")).toEqual([]);
  });

  it("has an entry for every project settings section and dev tools section", () => {
    expect(missing("project-settings-", PROJECT_SETTINGS_SECTIONS, ids), hint("Bereich der Projekt-Einstellungen", "buildActions (palette-actions.tsx)")).toEqual([]);
    expect(missing("devtools-", DEV_TOOLS_SECTIONS, ids), hint("Bereich der Dev-Tools", "buildActions (palette-actions.tsx)")).toEqual([]);
  });

  it("has an entry for every extensions tab", () => {
    expect(missing("ext-", EXTENSIONS_TABS, ids), hint("Tab der Erweiterungen", "EXTENSION_TAB_DEFS (ExtensionsView.tsx)")).toEqual([]);
    expect(missing("skills-", SKILLS_TABS, ids), hint("Tab der Skills", "SKILLS_TAB_DEFS (ExtensionsView.tsx)")).toEqual([]);
  });

  it("has an entry for every main view", () => {
    expect(missing("nav-", NAV.map((n) => n.view), ids), hint("Hauptansicht", "NAV (nav.ts)")).toEqual([]);
  });

  it("can switch every automation tag", () => {
    expect(missing("tag-", TAG_INFO.map((t) => t.tag), ids), hint("Automatik-Tag", "buildActions (palette-actions.tsx)")).toEqual([]);
  });

  it("can switch every boolean setting", () => {
    const listed = booleanSettings.filter((k) => !(k in UNLISTED_SETTINGS));
    expect(listed.length).toBeGreaterThan(0);
    expect(missing("setting-", listed, ids), hint("Schalter in Settings (models.ts)", "SETTING_TOGGLES oder mit Begründung in UNLISTED_SETTINGS (palette-actions.tsx)")).toEqual([]);
  });

  it("finds every blocklist rule", () => {
    expect(missing("policy-", PolicyRuleId.options, ids), hint("Regel der Sperrliste", "RULE_GROUPS (PolicySettings.tsx)")).toEqual([]);
  });

  it("offers the actions of the open project and session", () => {
    for (const id of ["session-delete", "session-summary", "session-fork", "session-close", "session-mode", "session-model-opus", "git-commit", "git-push", "git-pull", "git-fetch", "git-pr", "git-new-branch", "agent-new", "remote", "phone", "phone-test", "backup", "update-check", "update-install", "testdb-start", "dev-start", "project-git"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("leaves out Agenten, Git and git-only tags in a project without git and numbers the tabs as shown", () => {
    const noGit = { ...project, gitEnabled: false, git: null } as ProjectWithStatus;
    const list = buildActions({ ...fullContext(), project: noGit, root: noGit });
    const got = new Set(list.map((e) => e.id));
    for (const id of ["tab-agents", "tab-git", "tag-auto-commit", "tag-auto-push", "tag-auto-merge", "tag-review-required", "git-commit", "agent-new"]) expect(got, id).not.toContain(id);
    expect(got).toContain("tag-auto-test");
    expect(list.find((e) => e.id === "tab-files")?.hint).toBe("Strg+2");
    expect(list.find((e) => e.id === "project-git")?.label).toBe("Git für dieses Projekt einschalten");
  });

  it("shows the project folder and the open file in Explorer", () => {
    expect(ids).toContain("explorer-project");
    expect(ids).not.toContain("explorer-file");
    useUi.getState().selectFile(project.id, "src/main.ts");
    const list = buildActions(fullContext());
    expect(list.find((e) => e.id === "explorer-file")?.hint).toBe("src/main.ts");
  });

  it("gives every entry its own id", () => {
    expect(entries.length).toBe(ids.size);
  });

  it("leaves out project entries without an open project", () => {
    const none = buildActions({ ...fullContext(), project: null, root: null, session: null });
    expect(none.some((e) => e.id.startsWith("tab-") || e.id.startsWith("tag-") || e.id.startsWith("session-"))).toBe(false);
    expect(none.some((e) => e.id === "settings-general")).toBe(true);
  });
});

describe("palette ranking", () => {
  it("puts a label that starts with the query first, keyword-only matches last", () => {
    expect(rank("git öffnen", "git öffnen commit", ["git"])).toBe(0);
    expect(rank("neuen branch anlegen", "neuen branch anlegen git", ["branch"])).toBe(1);
    expect(rank("dateien öffnen", "dateien öffnen explorer", ["explorer"])).toBe(3);
    expect(rank("töne", "töne", ["xyz"])).toBe(-1);
  });
});

describe("file crawl", () => {
  it("skips installed and generated folders and lists shallow files first", async () => {
    const tree: Record<string, Array<{ name: string; path: string; isDir: boolean }>> = {
      "": [
        { name: "src", path: "src", isDir: true },
        { name: "node_modules", path: "node_modules", isDir: true },
        { name: ".github", path: ".github", isDir: true },
        { name: ".idea", path: ".idea", isDir: true },
        { name: "README.md", path: "README.md", isDir: false },
      ],
      src: [{ name: "main.ts", path: "src/main.ts", isDir: false }],
      ".github": [{ name: "ci.yml", path: ".github/ci.yml", isDir: false }],
    };
    const seen: string[] = [];
    const files = await crawlFiles(async (dir) => {
      seen.push(dir);
      return tree[dir] ?? [];
    });
    expect(files.map((f) => f.path)).toEqual(["README.md", "src/main.ts", ".github/ci.yml"]);
    expect(seen).not.toContain("node_modules");
    expect(seen).not.toContain(".idea");
  });
});
