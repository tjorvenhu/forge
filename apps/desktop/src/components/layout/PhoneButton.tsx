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
import { t } from "@/i18n";

function Duration({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
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
  const enable = () => run(() => call("phone.setEnabled", { enabled: true }), t.layout.phone.notEnabled);
  const disable = () => run(() => call("phone.setEnabled", { enabled: false }), t.layout.phone.notDisabled);
  const openSettings = () => useUi.getState().openSettings("phone");

  if (!state || !(state.enabled || state.call || config?.server)) return null;

  if (state.call) {
    const c = state.call;
    return (
      <div className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-success/40 bg-success-soft pl-3 pr-1 text-body">
        <PhoneCall className="h-3.5 w-3.5 animate-soft-pulse text-success" />
        <span className="max-w-36 truncate font-mono">{c.number || t.layout.phone.unknown}</span>
        {c.state === "ringing" ? <span className="text-muted">{c.direction === "out" ? t.layout.phone.ringing : t.layout.phone.connecting}</span> : <Duration since={c.startedAt} />}
        {c.unlocked && (
          <Tooltip content={t.layout.phone.unlocked}>
            <ShieldCheck className="h-3.5 w-3.5 text-success" />
          </Tooltip>
        )}
        <Tooltip content={c.reason ? t.layout.phone.hangUpReason(c.reason) : t.layout.phone.hangUp}>
          <Button size="icon-sm" variant="ghost" className="hover:text-danger" aria-label={t.layout.phone.hangUp} onClick={() => void run(() => call("phone.hangup", {}), t.layout.phone.hangUpFailed)}>
            <PhoneOff className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
    );
  }

  if (!state.enabled) {
    return (
      <Tooltip content={config?.hasPassword ? t.layout.phone.enable : t.layout.phone.setUp}>
        <Button size="icon" variant="ghost" className="h-9 w-9 rounded-lg" aria-label={t.layout.phone.enable} onClick={() => void (config?.hasPassword ? enable() : openSettings())}>
          <PhoneOff className="h-4 w-4" />
        </Button>
      </Tooltip>
    );
  }

  const calls = (config?.notifyNumbers ?? []).filter((n) => n.enabled).map((n) => n.label || n.number);
  const tone = state.registration === "registered" ? "text-success" : state.registration === "failed" ? "text-danger" : "text-warning animate-soft-pulse";
  const label =
    state.registration === "registered"
      ? t.layout.phone.on(calls, state.desk?.reachable === false)
      : state.registration === "failed"
        ? t.layout.phone.failedLabel(state.message ?? t.layout.phone.registrationFailed)
        : t.layout.phone.registering;
  return (
    <DropdownMenu
      header={label}
      trigger={
        <Button size="icon" variant="ghost" className="h-9 w-9 rounded-lg" aria-label={label} title={label}>
          <Phone className={cn("h-4 w-4", tone)} />
        </Button>
      }
      items={[
        ...(state.registration === "registered" && calls.length
          ? [{ label: t.layout.phone.testCall, icon: <PhoneOutgoing className="h-3.5 w-3.5" />, onSelect: () => void run(() => call("phone.testCall", {}), t.layout.phone.testCallFailed) }]
          : []),
        ...(state.registration === "failed" ? [{ label: t.layout.phone.reconnect, icon: <RotateCw className="h-3.5 w-3.5" />, onSelect: () => void enable() }] : []),
        { label: t.layout.phone.settings, icon: <Settings className="h-3.5 w-3.5" />, onSelect: openSettings },
        { label: t.layout.phone.turnOff, icon: <Power className="h-3.5 w-3.5" />, onSelect: () => void disable() },
      ]}
    />
  );
}

export function PhoneStatusBadge({ state }: { state: PhoneState }) {
  if (state.call?.state === "ringing") return <Badge tone="warning">{state.call.direction === "out" ? t.layout.phone.badgeRinging : t.layout.phone.badgeConnecting}</Badge>;
  if (state.call) return <Badge tone="success">{t.layout.phone.inCall}</Badge>;
  if (!state.enabled) return <Badge>{t.layout.phone.off}</Badge>;
  if (state.registration === "registered") return <Badge tone="success">{t.layout.phone.registered}</Badge>;
  if (state.registration === "failed") return <Badge tone="danger">{t.layout.phone.registrationFailed}</Badge>;
  return <Badge tone="warning">{t.layout.phone.registeringShort}</Badge>;
}
