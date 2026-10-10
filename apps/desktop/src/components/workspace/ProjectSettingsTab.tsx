import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert, Trash2, X } from "lucide-react";
import type { ProfileId, Project, EffortLevel } from "@forge/protocol";
import { call, keys, useRuntimeInfo, useSettings } from "@/lib/queries";
import { EFFORT_LEVELS, modelLabel } from "@/lib/models";

import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge, SectionTitle } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";
import { MemoryEditor } from "@/components/settings/MemoryEditor";

/** Tags with behaviour in FORGE (sessions, turn automation, policy). */
const TAG_INFO: Record<string, string> = {
  "plan-first": "Neue Sessions starten im Plan-Modus.",
  "auto-test": "Nach jedem Durchlauf läuft der Testbefehl, das Ergebnis steht im Chat.",
  "auto-commit": "Nach einem Durchlauf mit grünen Tests werden nur die dabei geänderten Dateien committet (KI-Nachricht).",
  "auto-push": "Nach Auto-Commit wird gepusht, nie auf main/master und nie mit Force.",
  "review-required": "Kein Auto-Commit: Commits nur nach Prüfung im Git-Bereich.",
  "no-network": "Claude bekommt keine Web-Tools (WebFetch, WebSearch).",
  "sandbox-only": "Autonomous ist in diesem Projekt gesperrt.",
};

export function ProjectSettingsTab({ project }: { project: Project }) {
  const qc = useQueryClient();
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [tagDraft, setTagDraft] = useState("");

  const update = async (patch: { profile?: ProfileId; tags?: string[]; defaultModel?: string | null; defaultEffort?: EffortLevel | null; name?: string; testCommand?: string | null }) => {
    try {
      await call("projects.update", { projectId: project.id, ...patch });
      await qc.invalidateQueries({ queryKey: keys.project(project.id) });
      void qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    }
  };

  const addTag = (t: string) => {
    const tag = t.trim().toLowerCase();
    if (!tag || project.tags.includes(tag)) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) {
      toast.error("Ungültiger Tag", "Nur Kleinbuchstaben, Ziffern und Bindestriche.");
      return;
    }
    void update({ tags: [...project.tags, tag] });
    setTagDraft("");
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="grid max-w-5xl gap-6 xl:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-4">
          <SectionTitle>Permission-Profil</SectionTitle>
          <div className="flex flex-col gap-2">
            {(["safe", "balanced", "autonomous"] as const).map((p) => {
              const locked = p === "autonomous" && !project.autonomousConfirmed;
              return (
                <button
                  key={p}
                  onClick={() => (locked ? setConfirmAuto(true) : void update({ profile: p }))}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left",
                    project.profile === p ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
                  )}
                  aria-pressed={project.profile === p}
                >
                  <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full border-2", project.profile === p ? "border-accent bg-accent" : "border-border-strong")} />
                  <span className="flex-1">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
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
          <p className="mt-3 text-xs text-subtle">
            Das Profil wird beim Start oder Fortsetzen einer Session an Claude Code übergeben (Permission-Modus default, acceptEdits oder bypassPermissions). Die FORGE-Sperrliste gilt
            in jedem Profil.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-surface p-4">
          <SectionTitle>Projekt</SectionTitle>
          <div className="flex flex-col gap-4">
            <Field label="Name">
              <Input defaultValue={project.name} onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && void update({ name: e.target.value.trim() })} />
            </Field>
            <Field label="Standardmodell für dieses Projekt">
              <Select
                value={project.defaultModel ?? "__inherit"}
                onChange={(v) => void update({ defaultModel: v === "__inherit" ? null : v })}
                className="w-full"
                options={[
                  { value: "__inherit", label: `Globale Einstellung (${settings.data?.defaultModel ? modelLabel(settings.data.defaultModel, runtime.data?.models) : "Claude-Code-Standard"})` },
                  ...(runtime.data?.models ?? []).filter((m) => m.value !== "default").map((m) => ({ value: m.value, label: m.displayName || m.value })),
                ]}
              />
            </Field>
            <Field label="Effort für dieses Projekt" hint="Wie gründlich Claude nachdenkt. Höher ist genauer, aber langsamer und verbraucht mehr vom Abo.">
              <Select
                value={project.defaultEffort ?? "__inherit"}
                onChange={(v) => void update({ defaultEffort: v === "__inherit" ? null : (v as EffortLevel) })}
                className="w-full"
                options={[
                  { value: "__inherit", label: `Globale Einstellung (${settings.data?.defaultEffort ?? "Claude-Code-Standard"})` },
                  ...EFFORT_LEVELS.map((l) => ({ value: l, label: l })),
                ]}
              />
            </Field>
            <Field label="Testbefehl" hint="Für den Tag auto-test. Wird in einer Shell im Projektordner ausgeführt.">
              <Input
                defaultValue={project.testCommand ?? ""}
                key={project.testCommand ?? ""}
                placeholder="z. B. pnpm test"
                className="font-mono text-xs"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== project.testCommand) void update({ testCommand: v });
                }}
              />
            </Field>
            <Field label="Tags" hint="Bekannte Tags steuern das Verhalten von FORGE, eigene Tags dienen der Ordnung.">
              <div className="flex flex-wrap gap-1.5">
                {project.tags.map((t) => (
                  <span key={t} title={TAG_INFO[t]} className="inline-flex items-center gap-1 rounded border border-border bg-surface-3 px-1.5 py-0.5 text-xs">
                    {t}
                    <button onClick={() => void update({ tags: project.tags.filter((x) => x !== t) })} aria-label={`Tag ${t} entfernen`} className="text-subtle hover:text-fg">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <Input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag(tagDraft)} placeholder="neuer-tag" className="h-7 text-xs" />
                <Button size="sm" onClick={() => addTag(tagDraft)} disabled={!tagDraft.trim()}>
                  Hinzufügen
                </Button>
              </div>
              <ul className="mt-3 grid grid-cols-[auto_1fr] items-start gap-x-2.5 gap-y-1.5 text-xs">
                {Object.entries(TAG_INFO).map(([t, info]) => {
                  const active = project.tags.includes(t);
                  return (
                    <li key={t} className="contents">
                      <button
                        onClick={() => (active ? void update({ tags: project.tags.filter((x) => x !== t) }) : addTag(t))}
                        className={cn("justify-self-start rounded border px-1.5 py-0.5 font-mono text-[11px]", active ? "border-accent bg-accent-soft text-fg" : "border-dashed border-border text-muted hover:text-fg")}
                        aria-pressed={active}
                      >
                        {t}
                      </button>
                      <span className="pt-0.5 text-subtle">{info}</span>
                    </li>
                  );
                })}
              </ul>
            </Field>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface p-4 xl:col-span-2">
          <SectionTitle>Regeln für Claude (CLAUDE.md)</SectionTitle>
          <MemoryEditor projectId={project.id} scopes={["project", "project-dir", "local", "global"]} />
        </section>

        <section className="rounded-xl border border-danger/30 bg-surface p-4 xl:col-span-2">
          <SectionTitle>Entfernen oder löschen</SectionTitle>
          <div className="flex items-center gap-3">
            <p className="flex-1 text-[13px] text-muted">Entfernt das Projekt aus FORGE. Auf Wunsch löscht FORGE auch den lokalen Ordner und das GitHub-Repository.</p>
            <Button variant="danger-ghost" onClick={() => setRemoving(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Entfernen …
            </Button>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmAuto}
        onOpenChange={setConfirmAuto}
        title="Autonomous für dieses Projekt aktivieren?"
        description={
          settings.data?.autonomousUnlocked
            ? "Claude arbeitet dann ohne Rückfragen (bypassPermissions). Nutze das nur, wenn dieses Projekt in einer isolierten Umgebung ohne Zugangsdaten liegt."
            : "Autonomous ist global gesperrt. Schalte es zuerst unter Einstellungen > Sicherheit frei."
        }
        confirmLabel="Autonomous aktivieren"
        danger
        requireText={settings.data?.autonomousUnlocked ? project.name : undefined}
        onConfirm={async () => {
          if (!settings.data?.autonomousUnlocked) return;
          try {
            await call("projects.confirmAutonomous", { projectId: project.id, confirmName: project.name });
            await qc.invalidateQueries({ queryKey: keys.project(project.id) });
            void qc.invalidateQueries({ queryKey: keys.projects });
            toast.success("Autonomous aktiv", "Gilt ab der nächsten Session.");
          } catch (e) {
            toast.error("Nicht aktiviert", errorMessage(e));
          }
        }}
      >
        <div className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          Bypass ist keine Sandbox. Befehle laufen mit deinen Benutzerrechten. Schreibzugriffe außerhalb des Projekts, Force-Push, reset --hard und Zugriffe auf Zugangsdaten bleiben
          von FORGE gesperrt.
        </div>
      </ConfirmDialog>
      <RemoveProjectDialog project={removing ? project : null} onClose={() => setRemoving(false)} />
    </div>
  );
}
