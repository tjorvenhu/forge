import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, ExternalLink, LogIn } from "lucide-react";
import type { MethodName } from "@forge/protocol";
import { call, keys, useClaudeSetup, useDiagnostics } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner, Spinner } from "@/components/ui/misc";

/** Install Claude Code and sign in without a terminal. The CLI does the actual work. */
export function ClaudeSetupCard() {
  const diag = useDiagnostics();
  const setup = useClaudeSetup();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const s = setup.data;
  const d = diag.data;
  const running = s?.phase === "running" || s?.phase === "waiting_code";

  // Open the sign-in page once when the CLI prints it.
  const url = s?.phase === "waiting_code" ? s.url : null;
  useEffect(() => {
    if (url) void openExternal(url);
  }, [url]);

  const act = async (method: Extract<MethodName, "claude.install" | "claude.login" | "claude.cancelSetup">) => {
    try {
      qc.setQueryData(keys.claudeSetup, await call(method, {}));
    } catch (e) {
      toast.error("Schritt fehlgeschlagen", errorMessage(e));
    }
  };

  if (!d) return <Spinner />;

  const log = s?.log.length ? (
    <pre className="max-h-40 w-full overflow-auto rounded-md bg-bg p-2 font-mono text-[11px] text-muted">{s.log.slice(-12).join("\n")}</pre>
  ) : null;

  if (!d.claude.found) {
    return (
      <div className="flex flex-col items-start gap-2.5">
        <div className="text-[13px]">Claude Code ist auf diesem Rechner noch nicht installiert.</div>
        <p className="text-xs text-muted">FORGE startet dafür den offiziellen Installer von Anthropic. Das dauert etwa eine Minute.</p>
        {s?.task === "install" && s.phase === "error" && <ErrorBanner title="Installation fehlgeschlagen">{s.message}</ErrorBanner>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void act("claude.install")} loading={running && s?.task === "install"}>
            <Download className="h-3.5 w-3.5" /> Claude Code installieren
          </Button>
          {running && (
            <Button variant="ghost" onClick={() => void act("claude.cancelSetup")}>
              Abbrechen
            </Button>
          )}
        </div>
        {s?.task === "install" && log}
      </div>
    );
  }

  if (!d.auth.loggedIn) {
    return (
      <div className="flex flex-col items-start gap-2.5">
        <div className="text-[13px]">Claude Code ist installiert, aber nicht angemeldet.</div>
        {s?.task === "login" && s.phase === "waiting_code" ? (
          <>
            <p className="text-xs text-muted">Melde dich im Browser an. Danach zeigt die Seite einen Code: hier einfügen und bestätigen.</p>
            <div className="flex w-full gap-2">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code von der Anmeldeseite" className="font-mono text-xs" autoFocus />
              <Button
                variant="primary"
                disabled={!code.trim()}
                onClick={async () => {
                  try {
                    qc.setQueryData(keys.claudeSetup, await call("claude.submitLoginCode", { code }));
                    setCode("");
                  } catch (e) {
                    toast.error("Code nicht übermittelt", errorMessage(e));
                  }
                }}
              >
                Bestätigen
              </Button>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => s.url && void openExternal(s.url)}>
                <ExternalLink className="h-3.5 w-3.5" /> Anmeldeseite erneut öffnen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void act("claude.cancelSetup")}>
                Abbrechen
              </Button>
            </div>
          </>
        ) : (
          <>
            {s?.task === "login" && s.phase === "error" && <ErrorBanner title="Anmeldung fehlgeschlagen">{s.message}</ErrorBanner>}
            <Button variant="primary" onClick={() => void act("claude.login")} loading={running}>
              <LogIn className="h-3.5 w-3.5" /> Mit Claude-Konto anmelden
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-[13px]">
      <CheckCircle2 className="h-4 w-4 text-success" />
      Claude Code {d.claude.version?.split(" ")[0]} ist eingerichtet
      {d.auth.subscriptionType && <Badge tone="success">{d.auth.subscriptionType} Abo</Badge>}
    </div>
  );
}
