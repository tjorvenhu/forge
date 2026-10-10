import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import type { ProjectTemplate } from "@forge/protocol";
import { call, keys, useSettings } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { useUi, type NewProjectMode } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox, ErrorBanner } from "@/components/ui/misc";
import { TabBar } from "@/components/ui/tabs";

const TEMPLATES: Array<{ value: ProjectTemplate; label: string; description: string }> = [
  { value: "empty", label: "Leer", description: "Nur die ausgewählten Dateien" },
  { value: "node-ts", label: "Node.js + TypeScript", description: "package.json, tsconfig.json, src/" },
  { value: "python", label: "Python", description: "pyproject.toml, src/" },
  { value: "rust", label: "Rust", description: "Cargo.toml, src/main.rs" },
];

export function NewProjectDialog() {
  const mode = useUi((s) => s.newProject);
  const setMode = useUi((s) => s.setNewProject);
  const openProject = useUi((s) => s.openProject);
  const settings = useSettings();
  const qc = useQueryClient();

  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("empty");
  const [opts, setOpts] = useState({ gitInit: true, readme: true, gitignore: true, claudeMd: true });
  const [url, setUrl] = useState("");
  const [dirName, setDirName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  const cloneUrl = useUi((s) => s.cloneUrl);
  useEffect(() => {
    if (mode === "clone" && cloneUrl) setUrl(cloneUrl);
  }, [mode, cloneUrl]);

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
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDuplicateId(null);
    try {
      const project =
        mode === "import"
          ? await call("projects.import", { path })
          : mode === "create"
            ? await call("projects.create", { name, parentDir: parent, template, ...opts })
            : await call("projects.clone", { url, parentDir: parent, dirName: dirName || undefined });
      await qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(mode === "import" ? "Projekt importiert" : mode === "create" ? "Projekt angelegt" : "Repository geklont", project.path);
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
      className="w-[580px]"
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

        {mode === "create" && (
          <>
            <Field label="Name" hint="Wird als Ordnername verwendet.">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mein-projekt" autoFocus />
            </Field>
            <Field label="Übergeordneter Ordner">
              <FolderInput value={parent} onChange={setParent} title="Übergeordneten Ordner wählen" />
            </Field>
            <Field label="Vorlage">
              <Select value={template} onChange={setTemplate} options={TEMPLATES} className="w-full" aria-label="Vorlage" />
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  ["gitInit", "Git initialisieren"],
                  ["readme", "README.md"],
                  ["gitignore", ".gitignore"],
                  ["claudeMd", "CLAUDE.md"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-[13px]">
                  <Checkbox checked={opts[k]} onChange={(v) => setOpts({ ...opts, [k]: v })} label={label} />
                  {label}
                </label>
              ))}
            </div>
          </>
        )}

        {mode === "clone" && (
          <>
            <Field label="Repository-URL" hint="https://, ssh:// oder git@host:pfad. Zugangsdaten verwaltet git bzw. gh.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/organisation/repo.git" autoFocus />
            </Field>
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
