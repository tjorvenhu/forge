import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { CREW_COLORS, CREW_RELAY_URL, type CrewProfile } from "@forge/protocol";
import { call, keys, useCrewProfile } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Input } from "@/components/ui/input";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { MemberAvatar } from "@/components/crew/CrewDialogs";
import { Group, Row } from "./layout";
import { t } from "@/i18n";

const m = t.crew;

/** This installation's name, color and relay in every crew (Settings > General). */
export function CrewProfileSettings() {
  const profile = useCrewProfile();
  if (profile.isPending) {
    return (
      <SkeletonRegion label={m.loading}>
        <Group title={m.profileTitle} description={m.profileDescription}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-6 px-4 py-3.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-8 w-64" />
            </div>
          ))}
        </Group>
      </SkeletonRegion>
    );
  }
  if (!profile.data) return null;
  return <ProfileForm profile={profile.data} />;
}

function ProfileForm({ profile }: { profile: CrewProfile }) {
  const qc = useQueryClient();
  const [name, setName] = useState(profile.name);
  const [relay, setRelay] = useState(profile.relayUrl ?? "");
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => setRelay(profile.relayUrl ?? ""), [profile.relayUrl]);
  const save = async (patch: { name?: string; color?: string; relayUrl?: string | null }) => {
    try {
      qc.setQueryData(keys.crewProfile, await call("crew.setProfile", patch));
      void qc.invalidateQueries({ queryKey: ["crews"] });
      toast.saved();
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    }
  };
  const relayValid = !relay.trim() || /^https?:\/\/\S+$/i.test(relay.trim());
  const saveName = () => {
    if (name.trim() && name.trim() !== profile.name) void save({ name: name.trim() });
    else setName(profile.name);
  };
  const saveRelay = () => {
    const next = relay.trim() || null;
    if (relayValid && next !== profile.relayUrl) void save({ relayUrl: next });
  };
  return (
    <Group title={m.profileTitle} description={m.profileDescription} action={<MemberAvatar name={name || profile.name} color={profile.color} size={26} />}>
      <Row label={m.profileName}>
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && saveName()} maxLength={40} className="w-64" aria-label={m.profileName} />
      </Row>
      <Row label={m.profileColor}>
        <div className="flex items-center gap-1.5" role="radiogroup" aria-label={m.profileColor}>
          {CREW_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={profile.color.toLowerCase() === c.toLowerCase()}
              aria-label={m.profileColorPick(c)}
              onClick={() => void save({ color: c })}
              className={cn("flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-transform duration-120 hover:scale-110", profile.color.toLowerCase() === c.toLowerCase() && "ring-2 ring-fg")}
              style={{ background: c }}
            >
              {profile.color.toLowerCase() === c.toLowerCase() && <Check className="h-3.5 w-3.5 text-white" />}
            </button>
          ))}
        </div>
      </Row>
      <Row label={m.profileRelay} description={m.profileRelayHint} stacked>
        <Input
          value={relay}
          onChange={(e) => setRelay(e.target.value)}
          onBlur={saveRelay}
          onKeyDown={(e) => e.key === "Enter" && saveRelay()}
          placeholder={CREW_RELAY_URL}
          className={cn("font-mono text-xs", !relayValid && "border-danger")}
          aria-label={m.profileRelay}
          aria-invalid={!relayValid}
        />
        {!relayValid && <span className="text-xs text-danger">{m.profileRelayInvalid}</span>}
      </Row>
    </Group>
  );
}
