import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { call, keys, useClaudeSetup, useSettings } from "@/lib/queries";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ClaudeLoginForm } from "./ClaudeSetupCard";

/** Sign in to Claude again without leaving the current view, e.g. after the login of a session expired. */
export function ClaudeLoginDialog() {
  const req = useUi((s) => s.claudeLogin);
  const settings = useSettings().data;
  const wizard = useUi((s) => s.setupWizard);
  // The setup assistant has its own sign-in step.
  if (!req || !settings || !settings.setupDone || wizard) return null;
  return <LoginDialog key={req.id} reason={req.reason} />;
}

function LoginDialog({ reason }: { reason: "expired" | "manual" }) {
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
    <Dialog
      open
      onOpenChange={(o) => !o && dismiss()}
      title={reason === "expired" ? "Claude-Anmeldung abgelaufen" : "Bei Claude anmelden"}
      description={
        reason === "expired"
          ? "Claude Code hat die Anmeldung abgelehnt. Melde dich hier mit deinem Claude-Konto neu an."
          : "Claude Code meldet sich mit deinem Claude-Konto an."
      }
      overlayClassName="backdrop-blur-sm"
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
          <span>
            Du bist wieder angemeldet.
            {reason === "expired" && " Schick die abgelehnte Nachricht einfach noch einmal."}
          </span>
        </div>
      ) : (
        <ClaudeLoginForm showError={started} onStart={() => setStarted(true)} />
      )}
    </Dialog>
  );
}
