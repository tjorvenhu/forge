import { ForgeError, PermissionMode } from "@forge/protocol";
import { PROFILES, resolveProfile } from "../policy/profiles.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { closeLive, describeRuntimeError } from "./live-session.js";
import type { SessionCore } from "./session-core.js";

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };

/** Permission mode and profile of sessions; the mode never goes above what the profile allows. */
export class PermissionModes {
  constructor(
    private readonly core: SessionCore,
    private readonly projects: ProjectManager,
  ) {}

  /**
   * Keeps the stored mode in line with Claude Code, e.g. after an accepted plan left plan mode. The
   * process is started with allowDangerouslySkipPermissions (so a profile switch can move it to bypass),
   * hence a reported mode above the profile is reset instead of stored.
   */
  sync(id: string, raw: string) {
    const { db } = this.core;
    const mode = PermissionMode.safeParse(raw);
    const rec = db.getSession(id);
    if (!mode.success || !rec) return;
    const live = this.core.live.get(id);
    const profile = live?.profile ?? PROFILES[rec.profile];
    if (MODE_RANK[mode.data] > MODE_RANK[profile.permissionMode]) {
      const target = MODE_RANK[rec.permissionMode] <= MODE_RANK[profile.permissionMode] ? rec.permissionMode : profile.permissionMode;
      this.core.record(id, {
        type: "policy.blocked",
        toolUseId: null,
        toolName: "PermissionMode",
        rule: "permission-mode",
        message: `Claude Code meldete den Modus ${mode.data}, das Profil ${profile.label} erlaubt höchstens ${profile.permissionMode}. FORGE hat den Modus auf ${target} zurückgesetzt.`,
      });
      if (live) {
        live.rt.setPermissionMode(target).catch((e: unknown) => {
          // A process stuck above its profile must not keep working.
          if (this.core.live.get(id) !== live) return;
          this.core.record(id, { type: "error", message: `Modus ließ sich nicht zurücksetzen, Session beendet: ${describeRuntimeError(e)}`, retryable: true });
          closeLive(live);
        });
      }
      if (rec.permissionMode !== target) this.core.publish(db.updateSession(id, { permissionMode: target }));
      return;
    }
    if (rec.permissionMode === mode.data) return;
    this.core.publish(db.updateSession(id, { permissionMode: mode.data }));
  }

  async set(sessionId: string, mode: PermissionMode) {
    const rec = this.core.db.getSession(sessionId);
    if (!rec) throw new ForgeError("SESSION_NOT_FOUND", "Session nicht gefunden.");
    const profile = PROFILES[rec.profile];
    if (MODE_RANK[mode] > MODE_RANK[profile.permissionMode]) {
      throw new ForgeError("POLICY_DENIED", `Das Profil ${profile.label} erlaubt den Modus ${mode} nicht.`);
    }
    const live = this.core.live.get(sessionId);
    if (live) await live.rt.setPermissionMode(mode);
    this.core.publish(this.core.db.updateSession(sessionId, { permissionMode: mode }));
  }

  /**
   * Applies the project's current profile to its open sessions: permission mode, approval scope and
   * write confinement take effect right away, also in the middle of a turn. Plan mode stays on.
   */
  async applyProjectProfile(projectId: string) {
    const project = this.projects.get(projectId);
    const profile = resolveProfile(project.profile, project.tags);
    for (const [id, live] of this.core.live) {
      const rec = this.core.db.getSession(id);
      if (rec?.projectId !== projectId) continue;
      const mode = rec.permissionMode === "plan" ? "plan" : profile.permissionMode;
      try {
        await live.rt.setPermissionMode(mode);
      } catch {
        // The process is ending (closed or crashed); it picks up the project profile when resumed.
        continue;
      }
      live.profile = profile;
      this.core.publish(this.core.db.updateSession(id, { profile: profile.id, permissionMode: mode }));
    }
  }
}
