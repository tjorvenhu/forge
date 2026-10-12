import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Phone, PhoneCall, PhoneOff, PhoneOutgoing, Power, RotateCw, Settings, ShieldCheck } from "lucide-react";
import type { PhoneSetupIncomplete, PhoneState } from "@forge/protocol";
import { call, keys, usePhoneConfig, usePhoneState } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, Tooltip } from "@/components/ui/misc";

function Duration({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return <span className="tabular-nums">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</span>;
}

/** Phone line on/off and the running call, top right in every view. Hidden until the phone is set up (server entered) or switched on. */
export function PhoneButton() {
  const state = usePhoneState().data;
  const config = usePhoneConfig().data;
  const qc = useQueryClient();
  const set = (s: PhoneState) => qc.setQueryData(keys.phoneState, s);

  const run = async (fn: () => Promise<PhoneState>, errorTitle: string) => {
    try {
      set(await fn());
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
      if (e instanceof RpcCallError && (e.details as Partial<PhoneSetupIncomplete> | undefined)?.phoneSetupIncomplete) useUi.getState().openSettings("phone");
    }
  };
  const enable = () => run(() => call("phone.setEnabled", { enabled: true }), "Telefon nicht eingeschaltet");
  const disable = () => run(() => call("phone.setEnabled", { enabled: false }), "Telefon nicht ausgeschaltet");
  const openSettings = () => useUi.getState().openSettings("phone");

  if (!state || !(state.enabled || state.call || config?.server)) return null;

  if (state.call) {
    const c = state.call;
    return (
      <div className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-success/40 bg-success-soft pl-3 pr-1 text-body">
        <PhoneCall className="h-3.5 w-3.5 animate-soft-pulse text-success" />
        <span className="max-w-36 truncate font-mono">{c.number || "unbekannt"}</span>
        {c.state === "ringing" ? <span className="text-muted">{c.direction === "out" ? "klingelt …" : "verbindet …"}</span> : <Duration since={c.startedAt} />}
        {c.unlocked && (
          <Tooltip content="PIN eingegeben: Steuern ist in diesem Gespräch erlaubt">
            <ShieldCheck className="h-3.5 w-3.5 text-success" />
          </Tooltip>
        )}
        <Tooltip content={c.reason ? `Anlass: ${c.reason}. Auflegen` : "Auflegen"}>
          <Button size="icon-sm" variant="ghost" className="hover:text-danger" aria-label="Auflegen" onClick={() => void run(() => call("phone.hangup", {}), "Auflegen fehlgeschlagen")}>
            <PhoneOff className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
    );
  }

  if (!state.enabled) {
    return (
      <Tooltip content={config?.hasPassword ? "Telefon einschalten" : "Telefon einrichten (Einstellungen)"}>
        <Button size="icon" variant="ghost" className="h-9 w-9 rounded-lg" aria-label="Telefon einschalten" onClick={() => void (config?.hasPassword ? enable() : openSettings())}>
          <PhoneOff className="h-4 w-4" />
        </Button>
      </Tooltip>
    );
  }

  const dot = state.registration === "registered" ? "bg-success" : state.registration === "failed" ? "bg-danger" : "bg-warning animate-soft-pulse";
  const label =
    state.registration === "registered"
      ? `Telefon an${config?.notifyNumber ? `, ruft ${config.notifyNumber} an` : ""}${state.desk?.reachable === false ? ". Tischtelefon nicht erreichbar" : ""}`
      : state.registration === "failed"
        ? `Telefon: ${state.message ?? "Anmeldung fehlgeschlagen"}`
        : "Telefon meldet sich an der Anlage an …";
  return (
    <DropdownMenu
      header={label}
      trigger={
        <Button size="icon" variant="ghost" className="relative h-9 w-9 rounded-lg" aria-label={label} title={label}>
          <Phone className={cn("h-4 w-4", state.registration === "registered" && "text-success")} />
          <span className={cn("absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full", dot)} />
        </Button>
      }
      items={[
        ...(state.registration === "registered" && config?.notifyNumber
          ? [{ label: "Testanruf", icon: <PhoneOutgoing className="h-3.5 w-3.5" />, onSelect: () => void run(() => call("phone.testCall", {}), "Testanruf fehlgeschlagen") }]
          : []),
        ...(state.registration === "failed" ? [{ label: "Erneut verbinden", icon: <RotateCw className="h-3.5 w-3.5" />, onSelect: () => void enable() }] : []),
        { label: "Telefon-Einstellungen", icon: <Settings className="h-3.5 w-3.5" />, onSelect: openSettings },
        { label: "Ausschalten", icon: <Power className="h-3.5 w-3.5" />, onSelect: () => void disable() },
      ]}
    />
  );
}

export function PhoneStatusBadge({ state }: { state: PhoneState }) {
  if (state.call?.state === "ringing") return <Badge tone="warning">{state.call.direction === "out" ? "klingelt" : "verbindet"}</Badge>;
  if (state.call) return <Badge tone="success">Gespräch läuft</Badge>;
  if (!state.enabled) return <Badge>aus</Badge>;
  if (state.registration === "registered") return <Badge tone="success">angemeldet</Badge>;
  if (state.registration === "failed") return <Badge tone="danger">Anmeldung fehlgeschlagen</Badge>;
  return <Badge tone="warning">meldet sich an …</Badge>;
}
