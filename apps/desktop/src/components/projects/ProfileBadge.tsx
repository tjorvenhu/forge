import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { Badge } from "@/components/ui/misc";
import { t } from "@/i18n";

export const PROFILE_IDS = ["safe", "balanced", "autonomous"] as const satisfies readonly ProfileId[];

export const PROFILE_INFO: Record<ProfileId, { label: string; description: string }> = {
  safe: { label: "Safe", description: t.projects.profile.safe },
  balanced: { label: "Balanced", description: t.projects.profile.balanced },
  autonomous: { label: "Autonomous", description: t.projects.profile.autonomous },
};

export function ProfileBadge({ profile }: { profile: ProfileId }) {
  if (profile === "safe")
    return (
      <Badge tone="success">
        <ShieldCheck className="h-3 w-3" /> Safe
      </Badge>
    );
  if (profile === "autonomous")
    return (
      <Badge tone="danger">
        <ShieldAlert className="h-3 w-3" /> Autonomous
      </Badge>
    );
  return (
    <Badge tone="warning">
      <Shield className="h-3 w-3" /> Balanced
    </Badge>
  );
}
