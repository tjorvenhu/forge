import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Copy } from "lucide-react";
import { convertRemoteUrl, isValidRemoteUrl, redactRemoteUrl, remoteKind } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { copyText } from "@/lib/context-menu";
import { useGitRemoteDialog } from "@/stores/git-remote";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const r = t.git.remote;

/** Shows and changes the URL of origin: switch between HTTPS and SSH, set another address or remove it. */
export function RemoteDialog() {
  const project = useGitRemoteDialog((s) => s.project);
  if (!project) return null;
  return <RemoteEditor key={project.id} project={project} />;
}

function RemoteEditor({ project }: { project: { id: string; name: string } }) {
  const qc = useQueryClient();
  const status = useGitStatus(project.id);
  const current = status.data?.summary.remoteUrl ?? null;
  /** null: not edited yet, the field shows origin as it is */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useGitRemoteDialog.getState().close();

  const value = draft ?? current ?? "";
  const url = value.trim();
  const removing = !url && current !== null;
  const valid = !url || isValidRemoteUrl(url);
  const kind = url ? remoteKind(url) : null;
  const other = kind === "https" ? "ssh" : kind === "ssh" ? "https" : null;
  const converted = other ? convertRemoteUrl(url, other) : null;
  const notRepo = status.error instanceof RpcCallError && status.error.code === "GIT_NOT_REPO";

  const save = async () => {
    setBusy(true);
    try {
      qc.setQueryData(keys.git(project.id), await call("git.setRemote", { projectId: project.id, url: url || null }));
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: ["pr", project.id] });
      toast.success(url ? r.saved : r.removed, url ? redactRemoteUrl(url) : undefined);
      close();
    } catch (e) {
      toast.error(r.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={r.title}
      description={r.description(project.name)}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t.git.common.cancel}
          </Button>
          <Button
            variant={removing ? "danger" : "primary"}
            loading={busy}
            disabled={!status.data || !valid || url === (current ?? "")}
            onClick={() => void save()}
          >
            {removing ? r.remove : r.save}
          </Button>
        </>
      }
    >
      {status.isLoading ? (
        <SkeletonRegion label={r.loading} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-28 rounded-sm" />
          <Skeleton className="h-9 w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-36" />
          </div>
        </SkeletonRegion>
      ) : notRepo ? (
        <p className="text-body text-muted">{r.notRepo}</p>
      ) : status.error ? (
        <ErrorBanner>{errorMessage(status.error)}</ErrorBanner>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label={r.label}>
            <Input
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && valid && url !== (current ?? "") && void save()}
              placeholder={r.placeholder}
              className="font-mono text-xs"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            {kind ? <Badge tone={kind === "other" ? "neutral" : "accent"}>{r.kind[kind]}</Badge> : <span className="text-caption text-subtle">{r.none}</span>}
            <span className="flex-1" />
            {converted && other && (
              <Button size="sm" variant="outline" onClick={() => setDraft(converted)}>
                <ArrowLeftRight className="h-3.5 w-3.5" /> {r.switchTo(r.kind[other])}
              </Button>
            )}
            {url && (
              <Button size="sm" variant="ghost" onClick={() => copyText(url)}>
                <Copy className="h-3.5 w-3.5" /> {r.copy}
              </Button>
            )}
          </div>
          {!valid ? (
            <p className="text-xs text-danger">{r.invalid}</p>
          ) : (
            <p className="text-xs text-subtle">
              {kind === "ssh" && `${r.sshHint} `}
              {current !== null && r.emptyRemoves}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
