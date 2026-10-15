import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, LogIn, LogOut, Settings2 } from "lucide-react";
import type { Diagnostics } from "@forge/protocol";
import { call, keys, useClaudeSetup, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi, type ClaudeLoginReason } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { MenuItem } from "@/components/ui/dropdown";
import { ClaudeLoginForm } from "./ClaudeSetupCard";

const TITLES: Record<ClaudeLoginReason, string> = {
  expired: "Claude-Anmeldung abgelaufen",
  manual: "Bei Claude anmelden",
  switch: "Claude-Konto wechseln",
};

const DESCRIPTIONS: Record<ClaudeLoginReason, string> = {
  expired: "Claude Code hat die Anmeldung abgelehnt. Melde dich hier mit deinem Claude-Konto neu an.",
  manual: "Claude Code meldet sich mit deinem Claude-Konto an.",
  switch: "Melde dich im Browser mit dem anderen Konto an. Ist dort noch das bisherige angemeldet, wechsle es auf claude.ai zuerst.",
};

const DONE: Record<ClaudeLoginReason, string> = {
  expired: "Du bist wieder angemeldet. Schick die abgelehnte Nachricht einfach noch einmal.",
  manual: "Claude Code ist angemeldet.",
  switch: "Claude Code nutzt jetzt das neue Konto. Laufende Sessions wechseln spätestens nach einem Neustart.",
};

/** Entries of the Claude card in the sidebar (click and right click). */
export function claudeAccountItems(d: Diagnostics | undefined, openSettings: () => void): MenuItem[] {
  const ui = useUi.getState();
  const settings: MenuItem = { label: "Claude-Einstellungen", icon: <Settings2 className="h-3.5 w-3.5" />, onSelect: openSettings };
  if (!d?.claude.found) return [settings];
  if (!d.auth.loggedIn) return [{ label: "Anmelden", icon: <LogIn className="h-3.5 w-3.5" />, onSelect: () => ui.openClaudeLogin("manual") }, settings];
  return [
    { label: "Konto wechseln", icon: <ArrowLeftRight className="h-3.5 w-3.5" />, onSelect: () => ui.openClaudeLogin("switch") },
    { label: "Abmelden", icon: <LogOut className="h-3.5 w-3.5" />, danger: true, onSelect: () => ui.setClaudeLogout(true) },
    settings,
  ];
}

/** Signs Claude Code out and refreshes everything that depends on the account. */
export async function logoutClaude(qc: QueryClient) {
  qc.setQueryData(keys.claudeSetup, await call("claude.logout", {}));
  qc.setQueryData(keys.diagnostics, await call("system.diagnostics", { refresh: true }));
  void qc.invalidateQueries({ queryKey: keys.usage });
  void qc.invalidateQueries({ queryKey: keys.runtimeInfo });
}

/** Sign in to Claude without leaving the current view: after an expired login, to switch accounts or by hand. */
export function ClaudeLoginDialog() {
  const req = useUi((s) => s.claudeLogin);
  const settings = useSettings().data;
  const wizard = useUi((s) => s.setupWizard);
  if (!req || !settings) return null;
  // The setup assistant has its own sign-in step; switching accounts is asked for by hand, also there.
  if (req.reason !== "switch" && (!settings.setupDone || wizard)) return null;
  return <LoginDialog key={req.id} reason={req.reason} />;
}

function LoginDialog({ reason }: { reason: ClaudeLoginReason }) {
  const close = useUi((s) => s.closeClaudeLogin);
  const s = useClaudeSetup().data;
  const qc = useQueryClient();
  const loggingIn = s?.task === "login" && (s.phase === "running" || s.phase === "waiting_code");
  // A login finished before this dialog opened is not this dialog's result; one still running is.
  const [started, setStarted] = useState(loggingIn);
  const done = started && s?.task === "login" && s.phase === "done";

  const dismiss = () => {
    if (loggingIn) void call("claude.cancelSetup", {}).then((st) => qc.setQueryData(keys.claudeSetup, st));
    close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && dismiss()} title={TITLES[reason]} description={DESCRIPTIONS[reason]} overlayClassName="backdrop-blur-sm"
      footer={
        done ? (
          <Button variant="primary" onClick={close}>
            Schließen
          </Button>
        ) : (
          <Button variant="ghost" onClick={dismiss}>
            Später
          </Button>
        )
      }
    >
      {done ? (
        <div className="flex items-start gap-2 text-body">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <span>{DONE[reason]}</span>
        </div>
      ) : (
        <ClaudeLoginForm showError={started} onStart={() => setStarted(true)} />
      )}
    </Dialog>
  );
}

/** Asks before signing out; opened from the sidebar card, its right-click menu and the palette. */
export function ClaudeLogoutDialog() {
  const open = useUi((s) => s.claudeLogout);
  const setOpen = useUi((s) => s.setClaudeLogout);
  const qc = useQueryClient();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Von Claude abmelden?"
      description="Claude Code meldet sich auf diesem Rechner ab. Sessions können erst nach einer neuen Anmeldung weiterarbeiten."
      confirmLabel="Abmelden"
      danger
      onConfirm={async () => {
        try {
          await logoutClaude(qc);
          toast.success("Von Claude abgemeldet");
        } catch (e) {
          toast.error("Abmelden fehlgeschlagen", errorMessage(e));
          throw e;
        }
      }}
    />
  );
}
