import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, FolderX, GitBranch } from "lucide-react";
import { call, keys, useGitHubAccount, useSettings } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useUi, type NewProjectMode } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Checkbox, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { RadioGroup } from "@/components/ui/radio-group";
import { Collapse } from "@/components/ui/collapse";
import { TabBar } from "@/components/ui/tabs";
import { GitHubRepoPicker } from "@/components/github/GitHubPanel";

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
  const github = useGitHubAccount();
  const [url, setUrl] = useState("");
  const [dirName, setDirName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  useEffect(() => {
    if (mode) {
      setError(null);
      setDuplicateId(null);
      if (!parent && settings.data?.defaultProjectDir) setParent(settings.data.defaultProjectDir);
    }
  }, [mode, parent, settings.data?.defaultProjectDir]);

  const close = () => {
    if (busy) return;
    setMode(null);
    setPath("");
    setName("");
    setUrl("");
    setDirName("");
    setWithGit(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDuplicateId(null);
    try {
      let project;
      if (mode === "create") {
        const r = await call("projects.create", { name, parentDir: parent, gitInit: withGit, gitEnabled: withGit, github: withGit && onGitHub ? { private: ghPrivate } : null });
        project = r.project;
        if (r.github?.url) toast.success("Projekt angelegt und auf GitHub veröffentlicht", r.github.url);
        else if (r.github?.error) toast.error("Projekt angelegt, GitHub-Repository fehlgeschlagen", r.github.error);
        else toast.success("Projekt angelegt", project.path);
      } else {
        project = mode === "import" ? await call("projects.import", { path, gitEnabled: withGit }) : await call("projects.clone", { url, parentDir: parent, dirName: dirName || undefined });
        toast.success(mode === "import" ? "Projekt importiert" : "Repository geklont", project.path);
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

  const canSubmit = mode === "import" ? !!path : mode === "create" ? !!name.trim() && !!parent : !!url.trim() && !!parent;

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => !o && close()}
      title="Projekt hinzufügen"
      className="w-145"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit} loading={busy}>
            {mode === "import" ? "Importieren" : mode === "create" ? "Anlegen" : "Klonen"}
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
            { value: "import", label: "Ordner importieren", icon: <FolderOpen className="h-3.5 w-3.5" /> },
            { value: "create", label: "Neu anlegen", icon: <FolderPlus className="h-3.5 w-3.5" /> },
            { value: "clone", label: "Repository klonen", icon: <GitBranch className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>

      <div className="flex flex-col gap-4">
        {mode === "import" && (
          <Field label="Projektordner" hint="Der Pfad wird geprüft und kanonisiert. Dubletten werden erkannt.">
            <FolderInput value={path} onChange={setPath} title="Projektordner wählen" />
          </Field>
        )}
        {mode === "import" && <GitChoice value={withGit} onChange={setWithGit} importing />}

        {mode === "create" && (
          <>
            <Field label="Name" hint="Wird als Ordnername verwendet.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mein-projekt" autoFocus />
            </Field>
            <Field label="Übergeordneter Ordner">
              <FolderInput value={parent} onChange={setParent} title="Übergeordneten Ordner wählen" />
            </Field>
            <p className="-mt-1 text-xs text-subtle">FORGE legt nur den Ordner an. Struktur, README und Konfiguration erstellt Claude in der ersten Session.</p>
            <GitChoice value={withGit} onChange={setWithGit} />
            <Collapse open={withGit}>
              <div className="rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-body">
                  <Checkbox checked={onGitHub} onChange={setOnGitHub} disabled={!github.data} label="Repository auf GitHub anlegen" />
                  Repository auf GitHub anlegen
                </label>
                {github.isPending ? (
                  <SkeletonRegion label="Lädt GitHub-Status" className="mt-1.5 flex h-4 items-center pl-6">
                    <Skeleton className="h-2.5 w-3/4" />
                  </SkeletonRegion>
                ) : github.data ? (
                  onGitHub && (
                    <div className="mt-2.5 flex items-center gap-4 pl-6 text-body">
                      <RadioGroup
                        aria-label="Sichtbarkeit des Repositorys"
                        value={ghPrivate ? "private" : "public"}
                        onChange={(v) => setGhPrivate(v === "private")}
                        options={[
                          { value: "private", label: "Privat" },
                          { value: "public", label: "Öffentlich" },
                        ]}
                      />
                      <span className="text-xs text-subtle">als {github.data.login}/{name.trim().replace(/\s+/g, "-") || "…"}</span>
                    </div>
                  )
                ) : (
                  <p className="mt-1.5 pl-6 text-xs text-subtle">
                    Dafür zuerst unter <SettingsLink onClick={close} /> bei GitHub anmelden.
                  </p>
                )}
              </div>
            </Collapse>
          </>
        )}

        {mode === "clone" && (
          <>
            {github.isPending ? (
              <SkeletonRegion label="Lädt GitHub-Status" className="flex flex-col gap-2">
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
                  <span className="mb-1.5 block text-xs font-medium text-muted">Deine Repositories</span>
                  <GitHubRepoPicker value={url} onPick={setUrl} />
                </div>
              )
            )}
            <div>
              <Field
                label={github.data ? "Oder Repository-URL" : "Repository-URL"}
                hint={github.data ? "Für Repositories anderer Konten oder Anbieter: https://, ssh:// oder git@host:pfad." : "https://, ssh:// oder git@host:pfad."}
              >
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/organisation/repo.git" autoFocus={!github.data} />
              </Field>
              {!github.data && !github.isPending && (
                <p className="mt-1 text-xs text-subtle">
                  Nach dem GitHub-Login unter <SettingsLink onClick={close} /> stehen hier deine Repositories zur Auswahl.
                </p>
              )}
            </div>
            <Field label="Zielordner">
              <FolderInput value={parent} onChange={setParent} title="Zielordner wählen" />
            </Field>
            <Field label="Ordnername (optional)" hint="Standard: Name des Repositorys">
              <Input value={dirName} onChange={(e) => setDirName(e.target.value)} />
            </Field>
          </>
        )}

        {error && (
          <ErrorBanner
            title="Nicht möglich"
            action={
              duplicateId ? (
                <Button
                  size="sm"
                  onClick={() => {
                    close();
                    openProject(duplicateId);
                  }}
                >
                  Öffnen
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

/** Mit or ohne Git; without git FORGE hides Agenten and Git and tells Claude not to use git. */
function GitChoice({ value, onChange, importing = false }: { value: boolean; onChange: (v: boolean) => void; importing?: boolean }) {
  const options = [
    {
      on: true,
      label: "Mit Git",
      Icon: GitBranch,
      hint: importing ? "Git-Bereich, Agenten und Commits. Ohne Repository legst du es später im Bereich Git an." : "Legt ein Git-Repository an. Mit Git-Bereich, Agenten und Commits.",
    },
    {
      on: false,
      label: "Ohne Git",
      Icon: FolderX,
      hint: importing ? "Keine Git-Bereiche, keine Agenten, Claude verwendet kein Git. Ein vorhandener .git-Ordner bleibt unberührt." : "Nur der Ordner. Keine Git-Bereiche, keine Agenten, Claude verwendet kein Git.",
    },
  ];
  return (
    <div role="radiogroup" aria-label="Versionsverwaltung" className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const active = o.on === value;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.on)}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-120",
              active ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-2",
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
      Einstellungen → Allgemein
    </button>
  );
}

function FolderInput({ value, onChange, title }: { value: string; onChange: (v: string) => void; title: string }) {
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="C:\Users\…\Projekte" className="font-mono text-xs" />
      <Button
        onClick={async () => {
          try {
            const p = await pickFolder(title, value || undefined);
            if (p) onChange(p);
          } catch (e) {
            toast.error("Ordnerdialog fehlgeschlagen", errorMessage(e));
          }
        }}
      >
        <FolderOpen className="h-3.5 w-3.5" /> Wählen
      </Button>
    </div>
  );
}
