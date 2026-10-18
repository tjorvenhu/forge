import { ForgeError, type PermissionMode, type ProfileId } from "@forge/protocol";
import { tr } from "../i18n/index.js";

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
export const NO_NETWORK_TAG = "no-network";
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];

/** Tools the profile and the project's tags forbid; the no-network tag turns web tools off regardless of profile. */
export function blockedTools(cfg: ProfileConfig, tags: readonly string[]): string[] {
  return [...new Set([...cfg.disallowedTools, ...(tags.includes(NO_NETWORK_TAG) ? NETWORK_TOOLS : [])])];
}

/**
 * "Allow for this session" lives inside the CLI process and cannot be taken back there. A switch to a
 * profile without that scope therefore needs a new process, or the old approvals keep working.
 */
export function revokesSessionApprovals(next: ProfileConfig, prev: ProfileConfig): boolean {
  return prev.allowSessionScope && !next.allowSessionScope;
}

/**
 * Resolves the effective profile for a session start. The sandbox-only tag is
 * checked again here so a project can never start with bypass while it is set.
 */
export function resolveProfile(profile: ProfileId, tags: readonly string[]): ProfileConfig {
  if (profile === "autonomous" && tags.includes(SANDBOX_ONLY_TAG)) {
    throw new ForgeError("POLICY_DENIED", tr().system.policy.sandboxOnly);
  }
  return PROFILES[profile];
}

export function effectivePermissionMode(cfg: ProfileConfig, planOnly: boolean): PermissionMode {
  return planOnly ? "plan" : cfg.permissionMode;
}
