import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CheckCircle2, Circle, CircleDashed, ExternalLink, Loader2, Pause, Play, Plus, Rocket, Trash2, XCircle } from "lucide-react";
import type { Schedule, WorkflowOptions, WorkflowRun, WorkflowStepState } from "@forge/protocol";
import { call, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, EmptyState, SectionTitle, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { TabBar } from "@/components/ui/tabs";

type Tab = "workflows" | "schedules";

export function AutomationsView() {
  const [tab, setTab] = useState<Tab>("workflows");
  return (
    <Page title="Automatisierungen" subtitle="Feature-Workflows von der Anforderung bis zum Pull Request und geplante Aufgaben">
      <div className="mb-4 border-b border-border">
        <TabBar<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "workflows", label: "Feature-Workflows", icon: <Rocket className="h-3.5 w-3.5" /> },
            { value: "schedules", label: "Geplant", icon: <CalendarClock className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="max-w-5xl">{tab === "workflows" ? <WorkflowsTab /> : <SchedulesTab />}</div>
    </Page>
  );
}

// ---------- feature workflows

const STEP_LABEL: Record<WorkflowStepState["step"], string> = {
  branch: "Branch anlegen",
  plan: "Plan erstellen",
  approve: "Plan freigeben",
  implement: "Umsetzen",
  test: "Tests",
  review: "Review",
  commit: "Commit",
  push: "Push",
  pr: "Pull Request",
};

function StepIcon({ s }: { s: WorkflowStepState["status"] }) {
  if (s === "done") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (s === "running") return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
  if (s === "waiting") return <Pause className="h-4 w-4 text-warning" />;
  if (s === "failed") return <XCircle className="h-4 w-4 text-danger" />;
  if (s === "skipped") return <CircleDashed className="h-4 w-4 text-subtle" />;
  return <Circle className="h-4 w-4 text-subtle" />;
}

function WorkflowsTab() {
  const runs = useQuery({ queryKey: ["workflows"], queryFn: () => call("workflows.list", {}) });
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const current = runs.data?.find((r) => r.id === selected) ?? runs.data?.[0];
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "Projekt";

  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-4">
      <section className="rounded-xl border border-border bg-surface p-3">
        <SectionTitle
          action={
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" /> Neu
            </Button>
          }
        >
          Läufe
        </SectionTitle>
        {runs.isLoading && <Spinner />}
        {runs.data?.length === 0 && <p className="px-1 text-xs text-muted">Noch keine Workflows. Starte mit „Neu“.</p>}
        <ul className="flex flex-col gap-0.5">
          {runs.data?.map((r) => (
            <li key={r.id}>
              <button onClick={() => setSelected(r.id)} className={cn("w-full rounded-md px-2 py-1.5 text-left", current?.id === r.id ? "bg-accent-soft" : "hover:bg-surface-3")}>
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <RunBadge run={r} />
                </div>
                <div className="truncate text-[11px] text-subtle">
                  {projectName(r.projectId)} · {relativeTime(r.createdAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
        {current ? (
          <RunDetail run={current} />
        ) : (
          <EmptyState icon={<Rocket className="h-8 w-8" />} title="Von der Anforderung zum Pull Request">
            Beschreibe eine Aufgabe. FORGE legt einen Branch oder Worktree an, lässt Claude planen und umsetzen, führt die Tests aus, zeigt dir den Diff und erstellt Commit, Push und
            Pull Request. Jeder Schritt ist sichtbar und kann angehalten werden.
          </EmptyState>
        )}
      </section>
      <NewWorkflowDialog open={creating} onOpenChange={setCreating} onStarted={(r) => setSelected(r.id)} />
    </div>
  );
}

function RunBadge({ run }: { run: WorkflowRun }) {
  const map = {
    running: { tone: "accent" as const, label: "läuft" },
    waiting: { tone: "warning" as const, label: "wartet" },
    failed: { tone: "danger" as const, label: "fehlgeschlagen" },
    done: { tone: "success" as const, label: "fertig" },
    cancelled: { tone: "neutral" as const, label: "abgebrochen" },
  }[run.status];
  return <Badge tone={map.tone}>{map.label}</Badge>;
}

function RunDetail({ run }: { run: WorkflowRun }) {
  const qc = useQueryClient();
  const openProject = useUi((s) => s.openProject);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ["workflows"] });
    } catch (e) {
      toast.error("Aktion fehlgeschlagen", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const waitingStep = run.status === "waiting" ? run.step : null;
  const workProject = run.workProjectId ?? run.projectId;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{run.title}</h2>
            <RunBadge run={run} />
          </div>
          <div className="font-mono text-xs text-muted">{run.branch}</div>
        </div>
        {run.sessionId && (
          <Button size="sm" onClick={() => openProject(workProject, run.sessionId)}>
            Session öffnen
          </Button>
        )}
        {run.prUrl && (
          <Button size="sm" variant="primary" onClick={() => void openExternal(run.prUrl!)}>
            <ExternalLink className="h-3.5 w-3.5" /> Pull Request
          </Button>
        )}
        {(run.status === "running" || run.status === "waiting") && (
          <Button size="sm" variant="danger-ghost" onClick={() => void act(() => call("workflows.cancel", { id: run.id }))}>
            Abbrechen
          </Button>
        )}
      </div>
      <p className="whitespace-pre-wrap rounded-lg bg-bg p-3 text-[13px] text-muted">{run.requirement}</p>

      <ol className="flex flex-col gap-1">
        {run.steps.map((s) => (
          <li key={s.step} className={cn("rounded-lg px-3 py-2", s.status === "waiting" ? "bg-warning-soft" : s.status === "failed" ? "bg-danger-soft" : "")}>
            <div className="flex items-center gap-2 text-[13px]">
              <StepIcon s={s.status} />
              <span className={cn(s.status === "skipped" && "text-subtle")}>{STEP_LABEL[s.step]}</span>
              {s.at && <span className="ml-auto text-[11px] text-subtle">{relativeTime(s.at)}</span>}
            </div>
            {s.message && s.status !== "pending" && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words pl-6 font-sans text-xs text-muted">{s.message}</pre>
            )}
          </li>
        ))}
      </ol>

      {waitingStep === "approve" && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 p-3">
          <p className="text-[13px]">Lies den Plan in der Session und gib ihn frei, oder beschreibe Änderungen.</p>
          <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="Was soll am Plan anders sein? (optional)" />
          <div className="flex gap-2">
            <Button variant="primary" loading={busy} onClick={() => void act(() => call("workflows.approvePlan", { id: run.id, approve: true }))}>
              Plan freigeben
            </Button>
            <Button
              disabled={!feedback.trim()}
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await call("workflows.approvePlan", { id: run.id, approve: false, feedback });
                  setFeedback("");
                })
              }
            >
              Überarbeiten lassen
            </Button>
          </div>
        </div>
      )}
      {waitingStep === "test" && (
        <div className="flex gap-2">
          <Button variant="primary" loading={busy} onClick={() => void act(() => call("workflows.fixTests", { id: run.id }))}>
            Claude die Fehler beheben lassen
          </Button>
        </div>
      )}
      {waitingStep === "review" && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 p-3">
          <p className="flex-1 text-[13px]">Prüfe die Änderungen im Git-Bereich des Projekts.</p>
          <Button onClick={() => openProject(workProject)}>Zum Projekt</Button>
          <Button variant="primary" loading={busy} onClick={() => void act(() => call("workflows.continue", { id: run.id }))}>
            Geprüft, weiter
          </Button>
        </div>
      )}
      {run.status === "failed" && run.error && <p className="text-xs text-danger">{run.error}</p>}
    </div>
  );
}

const DEFAULT_OPTIONS: WorkflowOptions = { useWorktree: true, approvePlan: true, runTests: true, review: true, push: false, createPr: false, draftPr: true };

function NewWorkflowDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; onStarted: (r: WorkflowRun) => void }) {
  const projects = useProjects();
  const activeProjectId = useUi((s) => s.activeProjectId);
  const qc = useQueryClient();
  const list = (projects.data ?? []).filter((p) => p.exists && p.git && !p.parentId);
  const [projectId, setProjectId] = useState<string | undefined>(activeProjectId ?? undefined);
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [options, setOptions] = useState<WorkflowOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const project = list.find((p) => p.id === projectId) ?? list[0];
  const opt = (k: keyof WorkflowOptions, label: string, hint?: string) => (
    <label className="flex items-start gap-2 text-[13px]">
      <span className="mt-0.5">
        <Checkbox checked={options[k]} onChange={(v) => setOptions({ ...options, [k]: v })} label={label} />
      </span>
      <span>
        {label}
        {hint && <span className="block text-xs text-subtle">{hint}</span>}
      </span>
    </label>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Neuer Feature-Workflow"
      className="w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!project || !title.trim() || !requirement.trim()}
            onClick={async () => {
              if (!project) return;
              setBusy(true);
              try {
                const r = await call("workflows.start", { projectId: project.id, title, requirement, options });
                void qc.invalidateQueries({ queryKey: ["workflows"] });
                onStarted(r);
                onOpenChange(false);
                setTitle("");
                setRequirement("");
              } catch (e) {
                toast.error("Workflow nicht gestartet", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Rocket className="h-3.5 w-3.5" /> Starten
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Projekt">
          <Select value={project?.id} onChange={setProjectId} className="w-full" options={list.map((p) => ({ value: p.id, label: p.name, description: p.git?.branch ?? "" }))} placeholder="Projekt mit Git wählen" />
        </Field>
        <Field label="Titel" hint="Daraus entsteht der Branch-Name">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CSV-Export für Bestellungen" autoFocus />
        </Field>
        <Field label="Anforderung">
          <Textarea value={requirement} onChange={(e) => setRequirement(e.target.value)} rows={5} placeholder="Was soll umgesetzt werden? Akzeptanzkriterien, Grenzen, Hinweise." />
        </Field>
        <div className="grid grid-cols-2 gap-2.5">
          {opt("useWorktree", "Eigener Worktree", "Parallel arbeiten, dein Arbeitsstand bleibt unberührt")}
          {opt("approvePlan", "Plan freigeben", "Claude plant zuerst, du gibst frei")}
          {opt("runTests", "Tests ausführen", project?.testCommand ? project.testCommand : "Kein Testbefehl im Projekt hinterlegt")}
          {opt("review", "Diff prüfen vor Commit")}
          {opt("push", "Pushen")}
          {opt("createPr", "Pull Request erstellen", "Schließt Push ein")}
          {options.createPr && opt("draftPr", "Als Entwurf")}
        </div>
      </div>
    </Dialog>
  );
}

// ---------- schedules

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function SchedulesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["schedules"], queryFn: () => call("schedules.list", {}) });
  const projects = useProjects();
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "Projekt";
  const refresh = () => qc.invalidateQueries({ queryKey: ["schedules"] });

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle
        action={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" /> Neu
          </Button>
        }
      >
        Geplante Aufgaben
      </SectionTitle>
      <p className="mb-3 text-xs text-muted">
        Startet zur eingestellten Zeit eine Session mit deinem Prompt, solange FORGE geöffnet ist. Freigaben laufen wie gewohnt über das Profil des Projekts.
      </p>
      {list.data?.length === 0 && <EmptyState icon={<CalendarClock className="h-8 w-8" />} title="Noch nichts geplant" />}
      <div className="divide-y divide-border rounded-lg border border-border">
        {list.data?.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
            <Checkbox
              checked={s.enabled}
              label={`${s.name} aktiv`}
              onChange={async (v) => {
                await call("schedules.save", { ...s, enabled: v });
                void refresh();
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button className="truncate text-left hover:underline" onClick={() => setEditing(s)}>
                  {s.name}
                </button>
                {s.planOnly && <Badge tone="accent">nur planen</Badge>}
              </div>
              <div className="text-[11px] text-subtle">
                {projectName(s.projectId)} · {s.weekdays.map((d) => WEEKDAYS[d - 1]).join(", ")} um {s.time}
                {s.lastRunAt && ` · zuletzt ${relativeTime(s.lastRunAt)}`}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await call("schedules.runNow", { id: s.id });
                  toast.success("Gestartet", s.name);
                  void refresh();
                } catch (e) {
                  toast.error("Nicht gestartet", errorMessage(e));
                }
              }}
            >
              <Play className="h-3.5 w-3.5" /> Jetzt
            </Button>
            <Button size="icon-sm" variant="danger-ghost" aria-label={`${s.name} löschen`} onClick={() => setRemoving(s)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {editing && <ScheduleDialog schedule={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => void refresh()} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Geplante Aufgabe löschen?"
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          if (!removing) return;
          await call("schedules.remove", { id: removing.id });
          void refresh();
        }}
      />
    </section>
  );
}

function ScheduleDialog({ schedule, onClose, onSaved }: { schedule: Schedule | null; onClose: () => void; onSaved: () => void }) {
  const projects = useProjects();
  const activeProjectId = useUi((s) => s.activeProjectId);
  const list = (projects.data ?? []).filter((p) => p.exists);
  const [projectId, setProjectId] = useState(schedule?.projectId ?? activeProjectId ?? list[0]?.id);
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [time, setTime] = useState(schedule?.time ?? "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(schedule?.weekdays ?? [1, 2, 3, 4, 5]);
  const [planOnly, setPlanOnly] = useState(schedule?.planOnly ?? false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={schedule ? "Geplante Aufgabe bearbeiten" : "Neue geplante Aufgabe"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!projectId || !name.trim() || !prompt.trim() || !weekdays.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)}
            onClick={async () => {
              if (!projectId) return;
              setBusy(true);
              try {
                await call("schedules.save", { id: schedule?.id, projectId, name, prompt, time, weekdays, planOnly, enabled: schedule?.enabled ?? true });
                onSaved();
                onClose();
              } catch (e) {
                toast.error("Nicht gespeichert", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Projekt">
          <Select value={projectId} onChange={setProjectId} className="w-full" options={list.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Abhängigkeiten prüfen" />
        </Field>
        <Field label="Prompt">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Prüfe veraltete Abhängigkeiten und fasse zusammen, was ein Update bräuchte." />
        </Field>
        <div className="flex items-end gap-4">
          <div className="w-28">
            <Field label="Uhrzeit">
              <Input value={time} onChange={(e) => setTime(e.target.value)} placeholder="09:00" className="font-mono" />
            </Field>
          </div>
          <div className="flex gap-1 pb-0.5" role="group" aria-label="Wochentage">
            {WEEKDAYS.map((d, i) => {
              const on = weekdays.includes(i + 1);
              return (
                <button
                  key={d}
                  onClick={() => setWeekdays(on ? weekdays.filter((x) => x !== i + 1) : [...weekdays, i + 1].sort())}
                  aria-pressed={on}
                  className={cn("h-8 w-9 rounded-md border text-xs", on ? "border-accent bg-accent-soft text-fg" : "border-border text-muted")}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={planOnly} onChange={setPlanOnly} label="Nur planen" /> Nur planen (Claude ändert nichts)
        </label>
      </div>
    </Dialog>
  );
}
