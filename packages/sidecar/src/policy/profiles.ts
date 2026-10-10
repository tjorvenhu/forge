import { ForgeError, type PermissionMode, type ProfileId } from "@forge/protocol";

export interface ProfileConfig {
  id: ProfileId;
  label: string;
  permissionMode: PermissionMode;
  /** may the user grant "allow for this session" on an approval card */
  allowSessionScope: boolean;
  disallowedTools: string[];
  /** writes outside the project are hard-denied by the guard */
  confineWritesToProject: boolean;
}

export const PROFILES: Record<ProfileId, ProfileConfig> = {
  safe: {
    id: "safe",
    label: "Safe",
    permissionMode: "default",
    allowSessionScope: false,
    disallowedTools: ["WebFetch", "WebSearch"],
    confineWritesToProject: false,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    permissionMode: "acceptEdits",
    allowSessionScope: true,
    disallowedTools: [],
    confineWritesToProject: false,
  },
  autonomous: {
    id: "autonomous",
    label: "Autonomous",
    permissionMode: "bypassPermissions",
    allowSessionScope: true,
    disallowedTools: [],
    confineWritesToProject: true,
  },
};

export interface ProfileGate {
  autonomousUnlocked: boolean;
  projectConfirmed: boolean;
}

/**
 * Resolves the effective profile for a session start. Autonomous needs both the
 * global unlock and the per-project confirmation; nothing from the repository
 * can satisfy either.
 */
export function resolveProfile(profile: ProfileId, gate: ProfileGate): ProfileConfig {
  if (profile === "autonomous" && !(gate.autonomousUnlocked && gate.projectConfirmed)) {
    throw new ForgeError(
      "PROFILE_LOCKED",
      "Autonomous ist gesperrt. Erst in den Einstellungen freischalten und im Projekt bestätigen.",
    );
  }
  return PROFILES[profile];
}

export function effectivePermissionMode(cfg: ProfileConfig, planOnly: boolean): PermissionMode {
  return planOnly ? "plan" : cfg.permissionMode;
}
