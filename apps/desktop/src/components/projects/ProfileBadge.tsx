import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { Badge } from "@/components/ui/misc";

export const PROFILE_IDS = ["safe", "balanced", "autonomous"] as const satisfies readonly ProfileId[];

export const PROFILE_INFO: Record<ProfileId, { label: string; description: string }> = {
  safe: { label: "Safe", description: "Jede Aktion einzeln freigeben, keine Web-Tools" },
  balanced: { label: "Balanced", description: "Datei-Edits im Projekt automatisch, Befehle mit Freigabe" },
  autonomous: { label: "Autonomous", description: "Keine Rückfragen. Die FORGE-Sperrliste gilt weiterhin" },
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
