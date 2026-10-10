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

export const SANDBOX_ONLY_TAG = "sandbox-only";

/**
 * Resolves the effective profile for a session start. The sandbox-only tag is
 * checked again here so a project can never start with bypass while it is set.
 */
export function resolveProfile(profile: ProfileId, tags: readonly string[]): ProfileConfig {
  if (profile === "autonomous" && tags.includes(SANDBOX_ONLY_TAG)) {
    throw new ForgeError("POLICY_DENIED", "Das Tag sandbox-only verbietet Autonomous in diesem Projekt.");
  }
  return PROFILES[profile];
}

export function effectivePermissionMode(cfg: ProfileConfig, planOnly: boolean): PermissionMode {
  return planOnly ? "plan" : cfg.permissionMode;
}
