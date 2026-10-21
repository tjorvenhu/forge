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

const PROFILE_LOOK = {
  safe: { Icon: ShieldCheck, tone: "success", text: "text-success" },
  balanced: { Icon: Shield, tone: "warning", text: "text-warning" },
  autonomous: { Icon: ShieldAlert, tone: "danger", text: "text-danger" },
} as const satisfies Record<ProfileId, { Icon: typeof Shield; tone: string; text: string }>;

/** The profile's shield in its colour, for menus next to the label. */
export function ProfileIcon({ profile }: { profile: ProfileId }) {
  const { Icon, text } = PROFILE_LOOK[profile];
  return <Icon className={`h-3.5 w-3.5 ${text}`} />;
}

export function ProfileBadge({ profile }: { profile: ProfileId }) {
  const { Icon, tone } = PROFILE_LOOK[profile];
  return (
    <Badge tone={tone}>
      <Icon className="h-3 w-3" /> {PROFILE_INFO[profile].label}
    </Badge>
  );
}
