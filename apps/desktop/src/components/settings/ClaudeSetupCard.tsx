import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, Download, ExternalLink, KeyRound, LogIn, LogOut } from "lucide-react";
import type { MethodName } from "@forge/protocol";
import { call, keys, useClaudeSetup, useDiagnostics } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { planLabel } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner, Spinner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const tc = t.settings.claudeSetup;

// Opens the sign-in page once per login attempt. Module-level so remounts and StrictMode do not open it again.
let openedUrl: string | null = null;

type SetupMethod = Extract<MethodName, "claude.install" | "claude.login" | "claude.cancelSetup">;

function useSetupAction() {
  const qc = useQueryClient();
  return async (method: SetupMethod) => {
    try {
      qc.setQueryData(keys.claudeSetup, await call(method, {}));
      return true;
    } catch (e) {
      toast.error(tc.stepFailed, errorMessage(e));
      return false;
    }
  };
}

/**
 * Sign-in with the Claude account through `claude auth login`: opens the sign-in page, which returns
 * to Claude Code on its own; pasting the code of the fallback page is offered too. Used in the setup card and in the dialog that opens when a session's login expired.
 */
export function ClaudeLoginForm({ showError = true, onStart }: { showError?: boolean; onStart?: () => void }) {
  const s = useClaudeSetup().data;
  const qc = useQueryClient();
  const act = useSetupAction();
  const running = s?.phase === "running" || s?.phase === "waiting_code";

  const url = s?.phase === "waiting_code" ? s.url : null;
  // The typed code belongs to one login attempt; a cancel or a new sign-in page starts empty.
  const [typed, setTyped] = useState<{ url: string | null; code: string }>({ url: null, code: "" });
  const code = typed.url === url ? typed.code : "";
  const setCode = (next: string) => setTyped({ url, code: next });
  const [submitting, setSubmitting] = useState(false);
  // sign-in page (s.url) for which the user chose to paste a code instead
  const [codeFor, setCodeFor] = useState<string | null>(null);
  useEffect(() => {
    if (url && openedUrl !== url) {
      openedUrl = url;
      void openExternal(url);
    }
  }, [url]);

  if (s?.task === "login" && s.phase === "waiting_code") {
    // With codeUrl the opened page returns to Claude Code on its own; the code is only the fallback.
    const withCode = !s.codeUrl || codeFor === s.url;
    const page = withCode ? (s.codeUrl ?? s.url) : s.url;
    const cancel = (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setCode("");
          void act("claude.cancelSetup");
        }}
      >
        {tc.cancel}
      </Button>
    );
    if (!withCode) {
      return (
        <div className="flex w-full flex-col items-start gap-2.5">
          <div className="flex items-center gap-2 text-body">
            <Spinner className="text-accent" /> {tc.waitingBrowser}
          </div>
          <p className="text-xs text-muted">{tc.waitingBrowserHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => s.url && void openExternal(s.url)}>
              <ExternalLink className="h-3.5 w-3.5" /> {tc.reopenPage}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCodeFor(s.url);
                if (s.codeUrl) void openExternal(s.codeUrl);
              }}
            >
              <KeyRound className="h-3.5 w-3.5" /> {tc.withCode}
            </Button>
            {cancel}
          </div>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-col items-start gap-2.5">
        <p className="text-xs text-muted">{tc.codeHint}</p>
        <div className="flex w-full gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={tc.codePlaceholder} className="font-mono text-xs" autoFocus />
          <Button
            variant="primary"
            disabled={!code.trim()}
            loading={submitting}
            onClick={async () => {
              if (submitting) return;
              setSubmitting(true);
              try {
                qc.setQueryData(keys.claudeSetup, await call("claude.submitLoginCode", { code }));
                setCode("");
              } catch (e) {
                toast.error(tc.codeNotSent, errorMessage(e));
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {tc.confirm}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => page && void openExternal(page)}>
            <ExternalLink className="h-3.5 w-3.5" /> {tc.reopenPage}
          </Button>
          {cancel}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-start gap-2.5">
      {showError && s?.task === "login" && s.phase === "error" && <ErrorBanner title={tc.loginFailed}>{s.message}</ErrorBanner>}
      <Button
        variant="primary"
        onClick={async () => {
          if (await act("claude.login")) onStart?.();
        }}
        loading={running}
      >
        <LogIn className="h-3.5 w-3.5" /> {tc.signInWithAccount}
      </Button>
    </div>
  );
}

/** Install Claude Code and sign in without a terminal. The CLI does the actual work. */
export function ClaudeSetupCard() {
  const diag = useDiagnostics();
  const setup = useClaudeSetup();
  const act = useSetupAction();
  const s = setup.data;
  const d = diag.data;
  const running = s?.phase === "running" || s?.phase === "waiting_code";

  if (!d)
    return (
      <SkeletonRegion label={tc.loading} className="flex h-5 items-center gap-2">
        <Skeleton className="h-4 w-4 rounded-full" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-4 w-12 rounded-full" />
      </SkeletonRegion>
    );

  const log = s?.log.length ? (
    <pre className="max-h-40 w-full overflow-auto rounded-md bg-bg p-2 font-mono text-caption text-muted">{s.log.slice(-12).join("\n")}</pre>
  ) : null;

  if (!d.claude.found) {
    return (
      <div className="flex flex-col items-start gap-2.5">
        <div className="text-body">{running && s?.task === "install" ? tc.installing : tc.notInstalled}</div>
        <p className="text-xs text-muted">{tc.installerHint}</p>
        {s?.task === "install" && s.phase === "error" && <ErrorBanner title={tc.installFailed}>{s.message}</ErrorBanner>}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void act("claude.install")} loading={running && s?.task === "install"}>
            <Download className="h-3.5 w-3.5" /> {tc.install}
          </Button>
          {running && (
            <Button variant="ghost" onClick={() => void act("claude.cancelSetup")}>
              {tc.cancel}
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
        <div className="text-body">{tc.notSignedIn}</div>
        <ClaudeLoginForm />
      </div>
    );
  }

  return (
    // Status left, actions right in one row: in narrow cards the buttons used to wrap to a line of their own.
    <div className="flex items-center gap-3 text-body">
      <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="truncate">{tc.ready(d.claude.version?.split(" ")[0] ?? "")}</span>
        {d.auth.subscriptionType && <Badge tone="success">{planLabel(d.auth)}</Badge>}
      </div>
      <div className="flex shrink-0 gap-1">
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().openClaudeLogin("switch")}>
          <ArrowLeftRight className="h-3.5 w-3.5" /> {tc.switchAccount}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().setClaudeLogout(true)}>
          <LogOut className="h-3.5 w-3.5" /> {tc.signOut}
        </Button>
      </div>
    </div>
  );
}
