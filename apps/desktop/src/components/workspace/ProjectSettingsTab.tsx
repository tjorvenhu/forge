import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, ShieldAlert, ShieldCheck, SlidersHorizontal, Trash2, Workflow, X } from "lucide-react";
import type { ProfileId, Project, EffortLevel } from "@forge/protocol";
import { call, keys, useRuntimeInfo, useSettings } from "@/lib/queries";
import { modelLabel } from "@/lib/models";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi, type ProjectSettingsSection } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";
import { MemoryEditor } from "@/components/settings/MemoryEditor";
import { Group, Row, SettingsLayout, SwitchRow, type SettingsSectionDef } from "@/components/settings/layout";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";

/**
 * Tags with behaviour in FORGE (sessions, turn automation, policy), in the order they are shown.
 * rootOnly: the main project decides for its agents, so agent worktrees do not show the switch.
 * git: only works with git (GIT_TAGS), hidden in a project set up without git.
 */
export const TAG_INFO: ReadonlyArray<{ tag: string; label: string; info: string; rootOnly?: boolean; git?: boolean }> = [
  { tag: "plan-first", label: "Erst planen", info: "Neue Sessions starten im Plan-Modus." },
  { tag: "auto-test", label: "Automatisch testen", info: "Nach jedem Durchlauf läuft der Testbefehl, das Ergebnis steht im Chat." },
  { tag: "auto-commit", label: "Automatisch committen", info: "Nach einem Durchlauf mit grünen Tests werden nur die dabei geänderten Dateien committet (KI-Nachricht).", git: true },
  { tag: "auto-push", label: "Automatisch pushen", info: "Nach Auto-Commit wird gepusht, nie auf main/master und nie mit Force.", git: true },
  {
    tag: "auto-merge",
    label: "Agenten automatisch zusammenführen",
    info: "Endet der Durchlauf eines Agenten ohne Fehler (und mit grünen Tests bei Automatisch testen), übernimmt FORGE seinen Branch in den Branch, von dem er gestartet ist, meist main. Worktree und Branch werden danach gelöscht. Bei Konflikten löst der Agent sie selbst. Was nicht klappt, legt FORGE dir zur Entscheidung vor.",
    rootOnly: true,
    git: true,
  },
  { tag: "review-required", label: "Commits nur nach Prüfung", info: "Kein Auto-Commit: Commits nur nach Prüfung im Git-Bereich.", git: true },
  { tag: "no-network", label: "Ohne Internet", info: "Claude bekommt keine Web-Tools (WebFetch, WebSearch)." },
  { tag: "sandbox-only", label: "Autonomous sperren", info: "Autonomous ist in diesem Projekt gesperrt." },
];
const KNOWN_TAGS = new Set(TAG_INFO.map((t) => t.tag));

/** Name of a tag as the Automatik section shows it; own tags keep their name. */
export function tagLabel(tag: string): string {
  return TAG_INFO.find((t) => t.tag === tag)?.label ?? tag;
}
const SANDBOX_INFO = TAG_INFO.find((t) => t.tag === "sandbox-only")!.info;

export const SECTIONS: ReadonlyArray<SettingsSectionDef<ProjectSettingsSection>> = [
  { id: "general", label: "Allgemein", hint: "Name, Modell, Git, Testbefehl", Icon: SlidersHorizontal },
  { id: "permissions", label: "Berechtigungen", hint: "Was Claude ohne Rückfrage darf", Icon: ShieldCheck },
  { id: "automation", label: "Automatik", hint: "Planen, testen, committen, Tags", Icon: Workflow },
  { id: "rules", label: "Regeln für Claude", hint: "CLAUDE.md des Projekts", Icon: FileText },
  { id: "remove", label: "Entfernen", hint: "Aus FORGE oder ganz löschen", Icon: Trash2 },
];

type Patch = {
  profile?: ProfileId;
  tags?: string[];
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  name?: string;
  testCommand?: string | null;
  devCommand?: string | null;
  gitEnabled?: boolean;
};

export function ProjectSettingsTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const section = useUi((s) => s.projectSettingsSection);
  const setSection = useUi((s) => s.setProjectSettingsSection);

  const update = async (patch: Patch) => {
    try {
      await call("projects.update", { projectId: project.id, ...patch });
      await qc.invalidateQueries({ queryKey: keys.project(project.id) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      if (patch.devCommand !== undefined) void qc.invalidateQueries({ queryKey: keys.devServer(project.id) });
      toast.saved();
    } catch (e) {
      // Brings back the stored state after an optimistic change (tags).
      void qc.invalidateQueries({ queryKey: keys.project(project.id) });
      toast.error("Nicht gespeichert", errorMessage(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <SettingsLayout sections={SECTIONS} current={section} onSelect={setSection} label="Bereiche der Projekt-Einstellungen">
        {section === "general" ? (
          <GeneralSection project={project} update={update} />
        ) : section === "permissions" ? (
          <PermissionsSection project={project} update={update} />
        ) : section === "automation" ? (
          <AutomationSection project={project} update={update} />
        ) : section === "rules" ? (
          <Group title="Regeln für Claude" description="CLAUDE.md des Projekts (wird committet), .claude/CLAUDE.md, nur für dich (CLAUDE.local.md, nicht im Git) und die globalen Regeln.">
            <div className="p-4">
              <MemoryEditor projectId={project.id} scopes={["project", "project-dir", "local", "global"]} />
            </div>
          </Group>
        ) : (
          <RemoveSection project={project} />
        )}
      </SettingsLayout>
    </div>
  );
}

type SectionProps = { project: Project; update: (patch: Patch) => Promise<void> };

function GeneralSection({ project, update }: SectionProps) {
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  return (
    <>
      <Group title="Projekt" description="Gilt für neue Sessions in diesem Projekt. Pro Session lässt sich alles im Chat umstellen.">
        <Row label="Name" description="So heißt das Projekt in FORGE. Der Ordner bleibt, wie er ist.">
          <Input
            key={project.name}
            defaultValue={project.name}
            className="w-64"
            onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && void update({ name: e.target.value.trim() })}
          />
        </Row>
        <Row label="Modell" description="Leer gilt die globale Einstellung.">
          <Select
            value={toChoice(project.defaultModel)}
            onChange={(v) => void update({ defaultModel: fromChoice(v) })}
            className="w-64"
            options={modelOptions(
              runtime.data?.models ?? [],
              `Global (${settings.data?.defaultModel ? modelLabel(settings.data.defaultModel, runtime.data?.models) : "Claude-Code-Standard"})`,
              { descriptions: false },
            )}
          />
        </Row>
        <Row label="Aufwand" description="Wie gründlich Claude nachdenkt. Höher ist genauer, aber langsamer und verbraucht mehr vom Abo.">
          <Select
            value={toChoice(project.defaultEffort)}
            onChange={(v) => void update({ defaultEffort: fromChoice<EffortLevel>(v) })}
            className="w-64"
            options={effortOptions(`Global (${settings.data?.defaultEffort ?? "Claude-Code-Standard"})`)}
          />
        </Row>
      </Group>

      {!project.parentId && (
        <Group title="Versionsverwaltung">
          <SwitchRow
            label="Mit Git arbeiten"
            description={
              project.gitEnabled
                ? "Ausgeschaltet blendet FORGE die Bereiche Agenten und Git aus, und Claude verwendet in diesem Projekt kein Git. Automatisch committen, pushen und zusammenführen gehen dann aus. Ein vorhandener .git-Ordner bleibt unverändert."
                : "Das Projekt arbeitet ohne Git: keine Agenten, kein Git-Bereich, und Claude führt keine git-Befehle aus. Eingeschaltet legst du das Repository im Bereich Git an, falls noch keines da ist."
            }
            checked={project.gitEnabled}
            onChange={(on) => void update({ gitEnabled: on })}
          />
        </Group>
      )}

      <Group title="Befehle" description="Laufen in einer Shell im Projektordner. Den Dev-Server richtest du im Tab Dev-Tools ein.">
        <Row label="Testbefehl" description="Für „Automatisch testen“ unter Automatik. Bekommt die Variablen der Test-.env aus Dev-Tools." stacked>
          <CommandInput value={project.testCommand} placeholder="z. B. pnpm test" onSave={(v) => void update({ testCommand: v })} />
        </Row>
      </Group>
    </>
  );
}

function CommandInput({ value, placeholder, onSave }: { value: string | null; placeholder: string; onSave: (v: string | null) => void }) {
  return (
    <Input
      key={value ?? ""}
      defaultValue={value ?? ""}
      placeholder={placeholder}
      className="font-mono text-xs"
      onBlur={(e) => {
        const v = e.target.value.trim() || null;
        if (v !== value) onSave(v);
      }}
    />
  );
}

function PermissionsSection({ project, update }: SectionProps) {
  return (
    <Group
      title="Permission-Profil"
      description="Gilt sofort, auch für laufende Sessions. Ein aktiver Plan-Modus bleibt bestehen. Die Sperrliste von FORGE gilt in jedem Profil."
    >
      <div className="flex flex-col gap-2 p-4">
        {PROFILE_IDS.map((p) => {
          const locked = p === "autonomous" && project.tags.includes("sandbox-only");
          const active = project.profile === p;
          return (
            <button
              key={p}
              onClick={() => void update({ profile: p })}
              disabled={locked}
              title={locked ? SANDBOX_INFO : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-50",
                active ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-2",
              )}
              aria-pressed={active}
            >
              <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full border-2", active ? "border-accent bg-accent" : "border-border-strong")} />
              <span className="flex-1">
                <span className="flex items-center gap-2 text-body font-medium">
                  {PROFILE_INFO[p].label}
                  {p === "autonomous" && <ShieldAlert className="h-3.5 w-3.5 text-danger" />}
                  {locked && <Badge>gesperrt</Badge>}
                </span>
                <span className="block text-xs text-muted">{PROFILE_INFO[p].description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Group>
  );
}

function AutomationSection({ project, update }: SectionProps) {
  const [draft, setDraft] = useState("");
  const qc = useQueryClient();
  /** the list the last click asked for, while saves are under way; a refetch in between may still show an older one */
  const intended = useRef<string[] | null>(null);
  const saving = useRef(0);
  /**
   * Builds on the last click, not on this render, and shows the result at once: quick switches in a
   * row would otherwise each start from the same list and drop or double a tag.
   */
  const setTag = (tag: string, on: boolean) => {
    const key = keys.project(project.id);
    void qc.cancelQueries({ queryKey: key });
    const tags = new Set(intended.current ?? qc.getQueryData<Project>(key)?.tags ?? project.tags);
    if (on) tags.add(tag);
    else tags.delete(tag);
    const next = [...tags];
    intended.current = next;
    saving.current++;
    qc.setQueryData(key, (p: Project | undefined) => (p ? { ...p, tags: next } : p));
    void update({ tags: next }).finally(() => {
      if (--saving.current === 0) intended.current = null;
    });
  };
  const own = project.tags.filter((t) => !KNOWN_TAGS.has(t));
  const addOwn = () => {
    const tag = draft.trim().toLowerCase();
    if (!tag || project.tags.includes(tag)) return setDraft("");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) return toast.error("Ungültiger Tag", "Nur Kleinbuchstaben, Ziffern und Bindestriche.");
    setTag(tag, true);
    setDraft("");
  };
  return (
    <>
      <Group title="Automatik" description="Was FORGE in diesem Projekt selbst erledigt. Gespeichert als Tags des Projekts.">
        {TAG_INFO.filter((t) => !(t.rootOnly && project.parentId) && !(t.git && !project.gitEnabled)).map((t) => (
          <SwitchRow
            key={t.tag}
            label={t.label}
            description={
              <>
                {t.info} <span className="font-mono text-subtle">{t.tag}</span>
              </>
            }
            checked={project.tags.includes(t.tag)}
            onChange={(on) => setTag(t.tag, on)}
          />
        ))}
      </Group>

      <Group title="Eigene Tags" description="Nur zur Ordnung, ohne Wirkung. Zum Beispiel Kunde oder Status.">
        <div className="flex flex-col gap-3 px-4 py-3.5">
          {own.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {own.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded border border-border bg-surface-3 px-1.5 py-0.5 text-xs">
                  {t}
                  <button onClick={() => setTag(t, false)} aria-label={`Tag ${t} entfernen`} className="text-subtle hover:text-fg">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addOwn()} placeholder="neuer-tag" className="text-xs" />
            <Button onClick={addOwn} disabled={!draft.trim()}>
              Hinzufügen
            </Button>
          </div>
        </div>
      </Group>
    </>
  );
}

function RemoveSection({ project }: { project: Project }) {
  const [removing, setRemoving] = useState(false);
  return (
    <Group title="Entfernen oder löschen" danger>
      <Row label="Projekt entfernen" description="Entfernt das Projekt aus FORGE. Auf Wunsch löscht FORGE auch den lokalen Ordner und das GitHub-Repository.">
        <Button variant="danger-ghost" onClick={() => setRemoving(true)}>
          <Trash2 className="h-3.5 w-3.5" /> Entfernen …
        </Button>
      </Row>
      <RemoveProjectDialog project={removing ? project : null} onClose={() => setRemoving(false)} />
    </Group>
  );
}
