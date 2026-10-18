import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, LogIn, LogOut, Settings2 } from "lucide-react";
import type { Diagnostics } from "@forge/protocol";
import { call, keys, useClaudeSetup, useDiagnostics, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi, type ClaudeLoginReason } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import type { MenuItem } from "@/components/ui/dropdown";
import { t } from "@/i18n";
import { ClaudeLoginForm } from "./ClaudeSetupCard";

/** `required`: Claude Code is signed out, the dialog cannot be closed until the sign-in is done */
type DialogReason = ClaudeLoginReason | "required";

const tl = t.settings.claudeLogin;

const TITLES: Record<DialogReason, string> = tl.titles;

const DESCRIPTIONS: Record<DialogReason, string> = tl.descriptions;

const DONE: Record<DialogReason, string> = tl.done;

/** Entries of the Claude card in the sidebar (click and right click). */
export function claudeAccountItems(d: Diagnostics | undefined, openSettings: () => void): MenuItem[] {
  const ui = useUi.getState();
  const settings: MenuItem = { label: tl.claudeSettings, icon: <Settings2 className="h-3.5 w-3.5" />, onSelect: openSettings };
  if (!d?.claude.found) return [settings];
  if (!d.auth.loggedIn) return [{ label: tl.signIn, icon: <LogIn className="h-3.5 w-3.5" />, onSelect: () => ui.openClaudeLogin("manual") }, settings];
  return [
    { label: tl.switchAccount, icon: <ArrowLeftRight className="h-3.5 w-3.5" />, onSelect: () => ui.openClaudeLogin("switch") },
    { label: tl.signOut, icon: <LogOut className="h-3.5 w-3.5" />, danger: true, onSelect: () => ui.setClaudeLogout(true) },
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

/** Claude Code is installed but signed out: FORGE cannot be used until the user signs in. */
export function useLoginRequired(): boolean {
  const d = useDiagnostics().data;
  return !!d?.claude.found && d.auth.checked && !d.auth.loggedIn;
}

/**
 * Sign in to Claude without leaving the current view. Stays open while Claude Code is signed out;
 * otherwise opened after an expired login, to switch accounts or by hand.
 */
export function ClaudeLoginDialog() {
  const req = useUi((s) => s.claudeLogin);
  const close = useUi((s) => s.closeClaudeLogin);
  const settings = useSettings().data;
  const wizard = useUi((s) => s.setupWizard);
  const required = useLoginRequired();
  // The setup assistant has its own sign-in step.
  const blocking = required && !!settings?.setupDone && !wizard;
  // The required dialog replaces an asked-for one, which would otherwise come back after the sign-in.
  useEffect(() => {
    if (blocking && req) close();
  }, [blocking, req, close]);
  if (!settings) return null;
  if (blocking) return <LoginDialog key="required" reason="required" />;
  if (!req) return null;
  // Switching accounts is asked for by hand, also over the setup assistant.
  if (req.reason !== "switch" && (!settings.setupDone || wizard)) return null;
  return <LoginDialog key={req.id} reason={req.reason} />;
}

/** Chat windows: the sign-in itself runs in the main window, so each window does not open the page again. */
export function ClaudeLoginRequiredNotice() {
  if (!useLoginRequired()) return null;
  return (
    <Dialog
      open
      onOpenChange={() => {}}
      dismissable={false}
      title={tl.signedOutTitle}
      description={tl.signedOutDescription}
    />
  );
}

function LoginDialog({ reason }: { reason: DialogReason }) {
  const close = useUi((s) => s.closeClaudeLogin);
  const s = useClaudeSetup().data;
  const qc = useQueryClient();
  const loggingIn = s?.task === "login" && (s.phase === "running" || s.phase === "waiting_code");
  // A login finished before this dialog opened is not this dialog's result; one still running is.
  const [started, setStarted] = useState(loggingIn);
  const [checking, setChecking] = useState(false);
  const done = started && s?.task === "login" && s.phase === "done";
  const required = reason === "required";

  const dismiss = () => {
    if (required) return;
    if (loggingIn) void call("claude.cancelSetup", {}).then((st) => qc.setQueryData(keys.claudeSetup, st));
    close();
  };

  // Required: the dialog goes away once the refreshed diagnostics show the sign-in; this asks again if it lags.
  const recheck = async () => {
    setChecking(true);
    try {
      qc.setQueryData(keys.diagnostics, await call("system.diagnostics", { refresh: true }));
    } catch (e) {
      toast.error(tl.notChecked, errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const footer = required ? (
    done ? (
      <Button variant="primary" loading={checking} onClick={() => void recheck()}>
        {tl.continue}
      </Button>
    ) : undefined
  ) : done ? (
    <Button variant="primary" onClick={close}>
      {tl.close}
    </Button>
  ) : (
    <Button variant="ghost" onClick={dismiss}>
      {tl.later}
    </Button>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && dismiss()}
      dismissable={!required}
      title={TITLES[reason]}
      description={DESCRIPTIONS[reason]}
      footer={footer}
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
      title={tl.logoutTitle}
      description={tl.logoutDescription}
      confirmLabel={tl.signOut}
      danger
      onConfirm={async () => {
        try {
          await logoutClaude(qc);
          toast.success(tl.loggedOut);
        } catch (e) {
          toast.error(tl.logoutFailed, errorMessage(e));
          throw e;
        }
      }}
    />
  );
}
