import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PolicyRuleId, Settings, type ProjectWithStatus, type Session } from "@forge/protocol";
import { DEV_TOOLS_SECTIONS, EXTENSIONS_TABS, PROJECT_SETTINGS_SECTIONS, SETTINGS_SECTIONS, SKILLS_TABS, WORKSPACE_TABS, useUi } from "@/stores/ui";
import { TAG_INFO } from "@/components/workspace/ProjectSettingsTab";
import { buildActions, UNLISTED_SETTINGS, type ActionContext } from "./palette-actions";
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
  agentsEnabled: true,
  teamsEnabled: true,
  group: null,
  exists: true,
  profile: "balanced",
  tags: [],
  technologies: [],
  git: { isRepo: true, branch: "feature/x", remoteUrl: "https://github.com/a/forge.git", ahead: 1, behind: 0, changedCount: 2 },
} as unknown as ProjectWithStatus;

const session = { id: "s1", projectId: "p1", title: "Test", model: null, effort: null, profile: "balanced", permissionMode: "acceptEdits", status: "idle", live: true,
  background: [{ taskId: "b1", description: "Dev-Server", taskType: "local_bash", toolUseId: "tb1", startedAt: "", summary: null }],
  subagents: [{ taskId: "k1", toolUseId: "tu1", description: "Auth prüfen", agentType: null, summary: null, lastTool: null, toolUses: 0, startedAt: "" }],
} as unknown as Session;

/** Everything switched on that can show entries, so every area of FORGE has to appear. */
function fullContext(): ActionContext {
  const qc = new QueryClient();
  qc.setQueryData(keys.appUpdate, { currentVersion: "0.1.1", phase: "ready", latest: { version: "0.1.2", tag: "v0.1.2", notes: "", since: "0.1.1", publishedAt: null, size: null, kind: "patch", via: null, channelSwitch: false }, autoInstall: false, installerPath: "C:/tmp/u.zip", installable: true, checkedAt: null, message: null });
  qc.setQueryData(keys.appInstall, { checkable: true, complete: false, problems: [{ part: "gh", kind: "missing", label: "GitHub CLI fehlt" }], expectedRuntime: null, phase: "found", installer: { version: "0.1.1", tag: "v0.1.1", name: "FORGE_0.1.1_x64-setup.exe", size: null, source: "github", then: null }, received: null, installerPath: null, canDownload: true, checkedAt: null, message: null });
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
    templates: [
      { id: "t1", projectId: null, name: "Review vor Release", description: null, text: "Review", sortOrder: 0, createdAt: "", updatedAt: "" },
      { id: "t2", projectId: "p1", name: "Tests schreiben", description: "für die geänderten Dateien", text: "Tests für {datei}", sortOrder: 0, createdAt: "", updatedAt: "" },
    ],
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

  it("sets the idle time of Claude processes, without the current choice", () => {
    expect(ids).toContain("option-idle-close");
    const choices = buildActions({ ...fullContext(), settings: { ...settings, idleCloseMinutes: 60 } }).filter((e) => e.id.startsWith("idle-close-"));
    expect(choices.map((e) => e.label)).toEqual([
      "Untätige Sessions nicht mehr schließen",
      "Untätige Sessions schließen nach 15 Minuten",
      "Untätige Sessions schließen nach 30 Minuten",
      "Untätige Sessions schließen nach 2 Stunden",
      "Untätige Sessions schließen nach 4 Stunden",
    ]);
  });

  it("finds every blocklist rule", () => {
    expect(missing("policy-", PolicyRuleId.options, ids), hint("Regel der Sperrliste", "RULE_GROUPS (PolicySettings.tsx)")).toEqual([]);
  });

  it("runs every prompt template and opens their management", async () => {
    const { useTemplateDialogs } = await import("@/stores/templates");
    const t2 = entries.find((e) => e.id === "template-t2")!;
    expect(t2).toMatchObject({ label: "Vorlage: Tests schreiben", hint: "Forge" });
    expect(entries.find((e) => e.id === "template-t1")?.hint).toBe("global");
    t2.run();
    expect(useTemplateDialogs.getState().apply).toEqual({ projectId: "p1", templateId: "t2", values: {} });
    entries.find((e) => e.id === "templates-manage")!.run();
    expect(useUi.getState()).toMatchObject({ view: "settings", settingsSection: "templates" });
    entries.find((e) => e.id === "template-new")!.run();
    expect(useTemplateDialogs.getState().edit).toEqual({ id: null, projectId: null });
  });

  it("offers the actions of the open project and session", () => {
    for (const id of ["chat-find", "session-delete", "session-summary", "session-fork", "session-close", "session-mode", "session-model-opus", "git-commit", "git-push", "git-pull", "git-fetch", "git-pr", "git-new-branch", "agent-new", "remote", "phone", "phone-test", "backup", "update-check", "update-install", "install-check", "install-full", "install-file", "testdb-start", "dev-start", "project-git", "project-agents"]) {
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

  it("offers no new agent when the project switched them off, and switching off asks first", async () => {
    const { useAgentsSwitch } = await import("@/stores/agents-switch");
    const allowed = buildActions(fullContext()).find((e) => e.id === "project-agents")!;
    expect(allowed.label).toBe("Parallele Agenten ausschalten");
    allowed.run();
    expect(useAgentsSwitch.getState().confirm).toEqual({ id: "p1", name: "Forge" });
    useAgentsSwitch.getState().close();

    const off = { ...project, agentsEnabled: false } as ProjectWithStatus;
    const list = buildActions({ ...fullContext(), project: off, root: off });
    expect(list.map((e) => e.id)).not.toContain("agent-new");
    expect(list.find((e) => e.id === "project-agents")?.label).toBe("Parallele Agenten erlauben");
    // A worktree asks its main project.
    const wt = { ...project, id: "wt", parentId: "p1" } as ProjectWithStatus;
    expect(buildActions({ ...fullContext(), project: wt, root: off }).find((e) => e.id === "project-agents")?.label).toBe("Parallele Agenten erlauben");
  });

  it("offers the chat window of the shown session: open, take back, pin one by one", () => {
    const label = (ctx: ActionContext, id: string) => buildActions(ctx).find((e) => e.id === id)?.label;
    const base = fullContext();
    expect(label(base, "chat-window-open")).toBe("In eigenem Fenster öffnen");
    expect(label(base, "chat-window-pin")).toBe("Chat-Fenster im Vordergrund halten");
    const pinned = { ...base, chatWindows: { sessions: [session.id], pinned: [session.id] } };
    expect(label(pinned, "chat-window-open")).toBeUndefined();
    expect(label(pinned, "chat-window-recall")).toBe("Chat-Fenster zurückholen");
    expect(label(pinned, "chat-window-pin")).toBe("Chat-Fenster nicht mehr im Vordergrund halten");
  });

  it("shows the project folder and the open file in Explorer", () => {
    expect(ids).toContain("explorer-project");
    expect(ids).not.toContain("explorer-file");
    useUi.getState().selectFile(project.id, "src/main.ts");
    const list = buildActions(fullContext());
    expect(list.find((e) => e.id === "explorer-file")?.hint).toBe("src/main.ts");
  });

  it("offers to write to each background task and subagent of the session", () => {
    expect(entries.find((e) => e.id === "task-message-b1")?.label).toBe("Nachricht an Hintergrundaufgabe: Dev-Server");
    entries.find((e) => e.id === "task-message-tu1")!.run();
    expect(useUi.getState()).toMatchObject({ workspaceTab: "chat", taskView: { kind: "agent", sessionId: "s1", toolUseId: "tu1", title: "Auth prüfen", compose: true } });
    useUi.getState().openTask(null);
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
