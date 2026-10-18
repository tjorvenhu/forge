import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, FolderX, GitBranch } from "lucide-react";
import { call, keys, useFolderInspect, useGitHubAccount, useSettings } from "@/lib/queries";
import { useDebouncedValue } from "@/lib/timing-hooks";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useUi, type NewProjectMode } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Checkbox, ErrorBanner, InfoTip } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { RadioGroup } from "@/components/ui/radio-group";
import { Collapse } from "@/components/ui/collapse";
import { TabBar } from "@/components/ui/tabs";
import { GitHubRepoPicker } from "@/components/github/GitHubPanel";
import { GitHubOwnerSelect, repoNameOf } from "@/components/github/GitHubOwnerSelect";
import { t } from "@/i18n";

export function NewProjectDialog() {
  const mode = useUi((s) => s.newProject);
  const setMode = useUi((s) => s.setNewProject);
  const openProject = useUi((s) => s.openProject);
  const settings = useSettings();
  const qc = useQueryClient();

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [withGit, setWithGit] = useState(true);
  const [onGitHub, setOnGitHub] = useState(false);
  const [ghPrivate, setGhPrivate] = useState(true);
  /** "" is the personal account, otherwise an organisation */
  const [ghOwner, setGhOwner] = useState("");
  const github = useGitHubAccount();
  const [url, setUrl] = useState("");
  const [dirName, setDirName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);
  const settledPath = useDebouncedValue(mode === "import" ? path.trim() : "", 250);
  const inspected = useFolderInspect(settledPath);
  // A folder with a .git is imported with git anyway (the sidecar enforces it); the choice shows that.
  const hasGit = mode === "import" && settledPath === path.trim() && !!inspected.data?.hasGit;
  useEffect(() => {
    if (hasGit) setWithGit(true);
  }, [hasGit]);

  useEffect(() => {
    if (mode) {
      setError(null);
      setDuplicateId(null);
    }
  }, [mode]);

  const open = mode !== null;
  const defaultDir = settings.data?.defaultProjectDir;
  /** the default folder went in once for this opening; a field the user empties stays empty */
  const prefilled = useRef(false);
  useEffect(() => {
    if (!open) {
      prefilled.current = false;
      return;
    }
    if (prefilled.current || !defaultDir) return;
    prefilled.current = true;
    setParent((p) => p || defaultDir);
  }, [open, defaultDir]);

  const close = () => {
    if (busy) return;
    setMode(null);
    setPath("");
    setName("");
    setUrl("");
    setDirName("");
    setWithGit(true);
    setOnGitHub(false);
    setGhPrivate(true);
    setGhOwner("");
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDuplicateId(null);
    try {
      let project;
      const toGitHub = withGit && onGitHub && !!github.data;
      if (mode === "create") {
        const r = await call("projects.create", { name, parentDir: parent, gitInit: withGit, gitEnabled: withGit, github: toGitHub ? { private: ghPrivate, owner: ghOwner || null } : null });
        project = r.project;
        if (r.github?.url) toast.success(t.projects.newProject.createdAndPublished, r.github.url);
        else if (r.github?.error) toast.error(t.projects.newProject.createdRepoFailed, r.github.error);
        else toast.success(t.projects.newProject.created, project.path);
      } else if (mode === "import") {
        project = await call("projects.import", { path, gitEnabled: withGit });
        if (toGitHub) {
          // The import stands even if GitHub refuses (e.g. the folder already has an origin).
          try {
            const r = await call("github.publish", { projectId: project.id, private: ghPrivate, owner: ghOwner || undefined });
            toast.success(t.projects.newProject.importedAndPublished, r.url);
          } catch (e) {
            toast.error(t.projects.newProject.importedRepoFailed, errorMessage(e));
          }
        } else toast.success(t.projects.newProject.imported, project.path);
      } else {
        project = await call("projects.clone", { url, parentDir: parent, dirName: dirName || undefined });
        toast.success(t.projects.newProject.cloned, project.path);
      }
      await qc.invalidateQueries({ queryKey: keys.projects });
      setBusy(false);
      close();
      openProject(project.id, null);
    } catch (e) {
      setBusy(false);
      setError(errorMessage(e));
      if (e instanceof RpcCallError && e.code === "DUPLICATE_PROJECT") {
        const d = e.details as { projectId?: string } | undefined;
        setDuplicateId(d?.projectId ?? null);
      }
    }
  };

  const gitHubChoice = { enabled: onGitHub, onEnabled: setOnGitHub, isPrivate: ghPrivate, onPrivate: setGhPrivate, owner: ghOwner, onOwner: setGhOwner, onSettings: close };

  const canSubmit = mode === "import" ? !!path : mode === "create" ? !!name.trim() && !!parent : !!url.trim() && !!parent;

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => !o && close()}
      title={t.projects.newProject.title}
      className="w-145"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t.projects.newProject.cancel}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit} loading={busy}>
            {mode === "import" ? t.projects.newProject.import : mode === "create" ? t.projects.newProject.createButton : t.projects.newProject.cloneButton}
          </Button>
        </>
      }
    >
      <div className="-mt-1 mb-4 border-b border-border">
        <TabBar<NewProjectMode>
          value={mode ?? "import"}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          tabs={[
            { value: "import", label: t.projects.newProject.tabImport, icon: <FolderOpen className="h-3.5 w-3.5" /> },
            { value: "create", label: t.projects.newProject.tabCreate, icon: <FolderPlus className="h-3.5 w-3.5" /> },
            { value: "clone", label: t.projects.newProject.tabClone, icon: <GitBranch className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>

      <div className="flex flex-col gap-4">
        {mode === "import" && (
          <Field label={t.projects.newProject.projectFolder} hint={t.projects.newProject.projectFolderHint}>
            <FolderInput value={path} onChange={setPath} title={t.projects.newProject.pickProjectFolder} />
          </Field>
        )}
        {mode === "import" && <GitChoice value={withGit} onChange={setWithGit} importing hasGit={hasGit} />}
        {mode === "import" && (
          <Collapse open={withGit}>
            <GitHubRepoChoice {...gitHubChoice} repoName={path ? repoNameOf(path.split(/[\\/]/).filter(Boolean).pop() ?? "") : ""} importing />
          </Collapse>
        )}

        {mode === "create" && (
          <>
            <Field label={t.projects.newProject.name} hint={t.projects.newProject.nameHint}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.projects.newProject.namePlaceholder} autoFocus />
            </Field>
            <Field label={t.projects.newProject.parentFolder}>
              <FolderInput value={parent} onChange={setParent} title={t.projects.newProject.pickParentFolder} />
            </Field>
            <p className="-mt-1 text-xs text-subtle">{t.projects.newProject.createNote}</p>
            <GitChoice value={withGit} onChange={setWithGit} />
            <Collapse open={withGit}>
              <GitHubRepoChoice {...gitHubChoice} repoName={name.trim() ? repoNameOf(name) : ""} />
            </Collapse>
          </>
        )}

        {mode === "clone" && (
          <>
            {github.isPending ? (
              <SkeletonRegion label={t.projects.newProject.loadingGitHub} className="flex flex-col gap-2">
                <div className="flex h-4 items-center">
                  <Skeleton className="h-2.5 w-28" />
                </div>
                <Skeleton className="h-8 w-full" />
                <div className="divide-y divide-border rounded-lg border border-border">
                  {[45, 60, 35].map((w) => (
                    <div key={w} className="flex flex-col gap-1.5 px-3 py-2.5">
                      <Skeleton className="h-3" style={{ width: `${w}%` }} />
                      <Skeleton className="h-2.5" style={{ width: `${w + 20}%` }} />
                    </div>
                  ))}
                </div>
              </SkeletonRegion>
            ) : (
              github.data && (
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-muted">{t.projects.newProject.yourRepos}</span>
                  <GitHubRepoPicker value={url} onPick={setUrl} />
                </div>
              )
            )}
            <div>
              <Field
                label={github.data ? t.projects.newProject.orRepoUrl : t.projects.newProject.repoUrl}
                hint={github.data ? t.projects.newProject.repoUrlHintOther : t.projects.newProject.repoUrlHint}
              >
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/organisation/repo.git" autoFocus={!github.data} />
              </Field>
              {!github.data && !github.isPending && (
                <p className="mt-1 text-xs text-subtle">
                  {t.projects.newProject.reposAfterLoginBefore}
                  <SettingsLink onClick={close} />
                  {t.projects.newProject.reposAfterLoginAfter}
                </p>
              )}
            </div>
            <Field label={t.projects.newProject.targetFolder}>
              <FolderInput value={parent} onChange={setParent} title={t.projects.newProject.pickTargetFolder} />
            </Field>
            <Field label={t.projects.newProject.dirName} hint={t.projects.newProject.dirNameHint}>
              <Input value={dirName} onChange={(e) => setDirName(e.target.value)} />
            </Field>
          </>
        )}

        {error && (
          <ErrorBanner
            title={t.projects.newProject.notPossible}
            action={
              duplicateId ? (
                <Button
                  size="sm"
                  onClick={() => {
                    close();
                    openProject(duplicateId);
                  }}
                >
                  {t.projects.newProject.open}
                </Button>
              ) : undefined
            }
          >
            {error}
          </ErrorBanner>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Mit or ohne Git; without git FORGE hides Agenten and Git and tells Claude not to use git.
 * `hasGit`: the imported folder already is a repository, so "Ohne Git" is not offered.
 */
function GitChoice({ value, onChange, importing = false, hasGit = false }: { value: boolean; onChange: (v: boolean) => void; importing?: boolean; hasGit?: boolean }) {
  const options = [
    {
      on: true,
      label: t.projects.newProject.withGit,
      Icon: GitBranch,
      hint: hasGit ? t.projects.newProject.withGitExisting : importing ? t.projects.newProject.withGitImport : t.projects.newProject.withGitCreate,
    },
    {
      on: false,
      label: t.projects.newProject.withoutGit,
      Icon: FolderX,
      hint: hasGit ? t.projects.newProject.withoutGitExisting : importing ? t.projects.newProject.withoutGitImport : t.projects.newProject.withoutGitCreate,
    },
  ];
  return (
    <div role="radiogroup" aria-label={t.projects.newProject.versionControl} className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const active = o.on === value;
        const disabled = hasGit && !o.on;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.on)}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-50",
              active ? "border-accent bg-accent-soft" : "border-border enabled:hover:border-border-strong enabled:hover:bg-surface-2",
            )}
          >
            <o.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-accent" : "text-muted")} />
            <span className="flex-1">
              <span className="block text-body font-medium">{o.label}</span>
              <span className="block text-xs text-muted">{o.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Also create a repository on GitHub: in the personal account or an organisation, private or public. */
function GitHubRepoChoice({
  enabled,
  onEnabled,
  isPrivate,
  onPrivate,
  owner,
  onOwner,
  repoName,
  importing = false,
  onSettings,
}: {
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  isPrivate: boolean;
  onPrivate: (v: boolean) => void;
  owner: string;
  onOwner: (v: string) => void;
  repoName: string;
  importing?: boolean;
  onSettings: () => void;
}) {
  const github = useGitHubAccount();
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-body">
        <label className="flex items-center gap-2">
          <Checkbox checked={enabled} onChange={onEnabled} disabled={!github.data} label={t.projects.newProject.createOnGitHub} />
          {t.projects.newProject.createOnGitHub}
        </label>
        {importing && (
          <InfoTip>{t.projects.newProject.importGitHubInfo}</InfoTip>
        )}
      </div>
      {github.isPending ? (
        <SkeletonRegion label={t.projects.newProject.loadingGitHub} className="mt-1.5 flex h-4 items-center pl-6">
          <Skeleton className="h-2.5 w-3/4" />
        </SkeletonRegion>
      ) : github.data ? (
        enabled && (
          <div className="mt-2.5 flex flex-col gap-2 pl-6">
            <div className="flex items-center gap-4">
              <GitHubOwnerSelect value={owner} onChange={onOwner} className="min-w-0 flex-1" />
              <RadioGroup
                aria-label={t.projects.newProject.visibility}
                value={isPrivate ? "private" : "public"}
                onChange={(v) => onPrivate(v === "private")}
                options={[
                  { value: "private", label: t.projects.newProject.private },
                  { value: "public", label: t.projects.newProject.public },
                ]}
              />
            </div>
            <span className="truncate text-xs text-subtle">
              {t.projects.newProject.as(`${owner || github.data.login}/${repoName || "…"}`)}
            </span>
          </div>
        )
      ) : (
        <p className="mt-1.5 pl-6 text-xs text-subtle">
          {t.projects.newProject.signInBefore}
          <SettingsLink onClick={onSettings} />
          {t.projects.newProject.signInAfter}
        </p>
      )}
    </div>
  );
}

function SettingsLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-accent underline"
      onClick={() => {
        onClick();
        useUi.getState().openSettings("general");
      }}
    >
      {t.projects.newProject.settingsLink}
    </button>
  );
}

function FolderInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t.projects.newProject.folderPlaceholder} className="font-mono text-xs" />
      <Button
        onClick={async () => {
          try {
            const p = await pickFolder(title, value || undefined);
            if (p) onChange(p);
          } catch (e) {
            toast.error(t.projects.newProject.folderDialogFailed, errorMessage(e));
          }
        }}
      >
        <FolderOpen className="h-3.5 w-3.5" /> {t.projects.newProject.pick}
      </Button>
    </div>
  );
}
