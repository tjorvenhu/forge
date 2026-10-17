import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CircleCheck,
  CircleDashed,
  Cloud,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Phone,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { EffortLevel, ProfileId, Settings } from "@forge/protocol";
import { call, keys, useDiagnostics, useGitHubAccount, useGitIdentity, useRuntimeInfo, useSettings, useSyncProbe, useSyncStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi, type NewProjectMode } from "@/stores/ui";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SectionTitle } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { ClaudeSetupCard } from "@/components/settings/ClaudeSetupCard";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { SyncAvailableList } from "@/components/settings/SyncSettings";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { SyncOffer, useEnableSync, useNeedsPassphrase } from "./SyncOffer";

const STEPS = [
  { label: "Willkommen", hint: "Was FORGE kann", Icon: Sparkles, title: "Willkommen bei FORGE", lead: "FORGE arbeitet mit Claude Code und deinem Claude-Abo." },
  // the lead of this step says whether Claude Code is ready
  { label: "Claude Code", hint: "Installieren und anmelden", Icon: SquareTerminal, title: "Claude Code", lead: "" },
  {
    label: "GitHub",
    hint: "Konto und Synchronisierung",
    Icon: Cloud,
    title: "GitHub und Synchronisierung",
    lead: "Optional. Für private Repositories, Pull Requests und damit FORGE auf deinen anderen PCs dieselben Daten hat.",
  },
  { label: "Grundlagen", hint: "Ordner und Standards", Icon: SlidersHorizontal, title: "Ordner und Standards", lead: "Gilt für neue Projekte und Sessions. Einzelne Projekte können eigene Werte haben." },
  { label: "Los geht's", hint: "Erstes Projekt", Icon: Rocket, title: "FORGE ist eingerichtet", lead: "Lege ein Projekt an, importiere einen Ordner oder klone ein Repository." },
];

/**
 * Setup on the first start: Claude Code, GitHub with the sync, folder for projects, defaults and the
 * git identity. Opens on its own only while nothing was ever done with FORGE (setupDone, which
 * installations from before it already have); the palette opens it again.
 */
export function SetupWizard() {
  const settings = useSettings().data;
  const reopened = useUi((u) => u.setupWizard);
  if (!settings || (settings.setupDone && !reopened)) return null;
  return <Wizard s={settings} />;
}

function Wizard({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const setSetupWizard = useUi((u) => u.setSetupWizard);
  const setNewProject = useUi((u) => u.setNewProject);
  const account = useGitHubAccount();
  const diagnostics = useDiagnostics();
  const probe = useSyncProbe(!!account.data);
  const [step, setStep] = useState(0);
  const [chosenSync, setSync] = useState<boolean | null>(null);
  // Data from another computer is what a second installation wants; otherwise the user decides.
  const sync = chosenSync ?? (s.syncEnabled || !!probe.data?.found);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const needsPassphrase = useNeedsPassphrase();
  const enableSync = useEnableSync();
  const [identity, setIdentity] = useState<{ name: string; email: string } | null>(null);
  /** what the form was filled with; only a change against it is saved */
  const [filledFrom, setFilledFrom] = useState<{ name: string; email: string } | null>(null);
  const git = useGitIdentity(step >= 3);
  useAutoOpenGitHub();
  useEffect(() => {
    if (identity) return;
    // Not from a cache that a sync may have outdated: only the fresh answer fills the form.
    if (git.data && !git.isFetching) {
      const v = { name: git.data.name ?? "", email: git.data.email ?? "" };
      setIdentity(v);
      setFilledFrom(v);
    } else if (git.isError) setIdentity({ name: "", email: "" });
  }, [git.data, git.isFetching, git.isError, identity]);
  // The probe decides whether syncing is preselected; going on before it answered would decide it as "no".
  const probing = step === 2 && !!account.data && probe.isLoading && chosenSync === null;

  const save = async (patch: Partial<Settings>) => {
    qc.setQueryData(keys.settings, await call("settings.update", patch));
  };

  const finish = async (then?: () => void) => {
    try {
      // The sync was offered here; the question on a later start would ask it again right away.
      await save({ setupDone: true, syncAsked: true });
      setSetupWizard(false);
      then?.();
    } catch (e) {
      toast.error("Einrichtung nicht abgeschlossen", errorMessage(e));
    }
  };

  /** Leaving a step saves what it asked; the sync runs before the defaults, so they show what came from GitHub. */
  const next = async () => {
    setBusy(true);
    try {
      if (step === 2 && account.data) {
        if (sync) {
          if (needsPassphrase && !passphrase) throw new Error("Gib zuerst das Sync-Passwort ein.");
          const firstSync = await enableSync(passphrase);
          // Switched on all the same; the next sync tries again, the assistant goes on.
          if (firstSync) toast.info("Synchronisierung ist an", `Der erste Abgleich ist fehlgeschlagen: ${firstSync} FORGE versucht es gleich wieder.`);
        } else await save({ syncEnabled: false, syncAsked: true });
      }
      if (step === 3 && identity && filledFrom) {
        const name = identity.name.trim();
        const email = identity.email.trim();
        if (name && email && (name !== filledFrom.name || email !== filledFrom.email)) qc.setQueryData(keys.gitIdentity, await call("git.setIdentity", { name, email }));
      }
      setStep((x) => Math.min(x + 1, STEPS.length - 1));
    } catch (e) {
      toast.error(step === 2 ? "Synchronisieren fehlgeschlagen" : "Nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;
  const meta = STEPS[step]!;
  const claudeReady = !!diagnostics.data?.claude.found && !!diagnostics.data.auth.loggedIn;
  const lead = step === 1 ? (claudeReady ? "Alles bereit." : "Fehlt Claude Code, installiert FORGE es selbst. Danach meldest du dich mit deinem Claude-Konto an.") : meta.lead;
  return (
    <Dialog
      open
      hideHeader
      onOpenChange={(o) => !o && void finish()}
      title="FORGE einrichten"
      description="Alles lässt sich später unter Einstellungen ändern."
      className="h-150 w-220"
    >
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg/50 px-5 pb-5 pt-6">
          <Logo height={26} />
          <ol aria-label="Schritte" className="mt-9 flex flex-col">
            {STEPS.map((x, i) => (
              <StepItem key={x.label} label={x.label} hint={x.hint} index={i} step={step} last={i === STEPS.length - 1} onClick={busy || i >= step ? undefined : () => setStep(i)} />
            ))}
          </ol>
          <p className="mt-auto text-caption text-subtle">Alles lässt sich später unter Einstellungen ändern.</p>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start gap-3.5 px-7 pb-5 pt-7">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <meta.Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-caption text-subtle">
                Schritt {step + 1} von {STEPS.length}
              </p>
              <h2 className="text-title font-semibold">{meta.title}</h2>
              <p className="mt-1 text-body text-muted">{lead}</p>
            </div>
          </header>

          <div key={step} className="min-h-0 flex-1 animate-view-in overflow-y-auto px-7 pb-6">
            {step === 0 && <WelcomeStep />}

            {step === 1 && (
              <div className="rounded-lg border border-border bg-surface-2/40 p-4">
                <ClaudeSetupCard />
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-col gap-4">
                <GitHubStep />
                <SyncOffer checked={sync && !!account.data} onChange={setSync} onPassphrase={setPassphrase} />
              </div>
            )}

            {step === 3 && <BasicsStep s={s} save={save} identity={identity} setIdentity={setIdentity} loadingIdentity={!identity} gitMissing={git.isError} />}

            {step === 4 && <DoneStep s={s} claudeReady={diagnostics.data ? claudeReady : null} onProject={(m) => void finish(() => setNewProject(m))} />}
          </div>

          <footer className="flex items-center gap-2 border-t border-border px-7 py-3.5">
            {!last && (
              <Button variant="ghost" className="mr-auto" onClick={() => void finish()}>
                Überspringen
              </Button>
            )}
            {step > 0 && (
              <Button variant="ghost" className={cn(last && "mr-auto")} onClick={() => setStep((x) => x - 1)} disabled={busy}>
                <ArrowLeft className="h-3.5 w-3.5" /> Zurück
              </Button>
            )}
            {last ? (
              <Button variant="primary" onClick={() => void finish()}>
                <Check className="h-3.5 w-3.5" /> Fertig
              </Button>
            ) : (
              <Button variant="primary" loading={busy} disabled={probing} onClick={() => void next()} autoFocus>
                {step === 0 ? "Los" : "Weiter"} <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            )}
          </footer>
        </section>
      </div>
    </Dialog>
  );
}

/** One step in the rail: done steps carry a check and lead back to themselves. */
function StepItem({ label, hint, index, step, last, onClick }: { label: string; hint: string; index: number; step: number; last: boolean; onClick?: () => void }) {
  const done = index < step;
  const current = index === step;
  return (
    <li aria-current={current ? "step" : undefined} className={cn("relative", !last && "pb-5")}>
      {!last && <span aria-hidden className={cn("absolute bottom-0.5 left-3 top-7.5 w-px -translate-x-1/2", done ? "bg-accent/60" : "bg-border")} />}
      <button
        type="button"
        disabled={!onClick}
        onClick={onClick}
        className={cn("group flex w-full items-start gap-3 rounded-md text-left", onClick && "cursor-pointer")}
      >
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold transition-colors duration-120",
            done ? "border-accent bg-accent text-accent-fg" : current ? "border-accent bg-accent-soft text-accent" : "border-border-strong text-subtle",
          )}
        >
          {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : index + 1}
        </span>
        <span className="min-w-0 pt-0.5">
          <span className={cn("block text-body font-medium", current ? "text-fg" : done ? "text-muted group-hover:text-fg" : "text-subtle")}>{label}</span>
          <span className="block text-caption text-subtle">{hint}</span>
        </span>
      </button>
    </li>
  );
}

const FEATURES = [
  { Icon: FolderKanban, title: "Projekte und Sessions", text: "Jedes Projekt mit eigenen Chats, Einstellungen und Projektwissen." },
  { Icon: GitBranch, title: "Git im Projekt", text: "Änderungen, Commits, Branches und Pull Requests ohne Terminal." },
  { Icon: Bot, title: "Parallele Agenten", text: "Teilaufgaben laufen gleichzeitig, jede auf einem eigenen Branch." },
  { Icon: Phone, title: "Telefon", text: "FORGE per Anruf steuern und bei Rückfragen anrufen lassen." },
];

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        {FEATURES.map(({ Icon, title, text }) => (
          <div key={title} className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2/40 p-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-3 text-accent">
              <Icon className="h-4 w-4" />
            </span>
            <div>
              <p className="text-body font-medium">{title}</p>
              <p className="mt-0.5 text-small text-muted">{text}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-small text-subtle">Als Nächstes: Claude Code anmelden, GitHub verbinden, Ordner und Standards festlegen.</p>
    </div>
  );
}

function GitHubStep() {
  const gh = useDiagnostics().data?.gh;
  return (
    <div className="rounded-lg border border-border p-4">
      {gh && !gh.found ? <p className="text-body text-danger">Die GitHub-Anbindung fehlt in dieser Installation. Bitte FORGE neu installieren.</p> : <GitHubAccountCard />}
    </div>
  );
}

function BasicsStep({
  s,
  save,
  identity,
  setIdentity,
  loadingIdentity,
  gitMissing,
}: {
  s: Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
  identity: { name: string; email: string } | null;
  setIdentity: (v: { name: string; email: string }) => void;
  loadingIdentity: boolean;
  /** git could not be asked (not installed): there is no identity to set yet */
  gitMissing: boolean;
}) {
  const models = useRuntimeInfo().data?.models ?? [];
  const saveNow = (patch: Partial<Settings>) => void save(patch).catch((e: unknown) => toast.error("Einstellung nicht gespeichert", errorMessage(e)));
  return (
    <div className="flex flex-col gap-5">
      <BasicsGroup title="Projekte und Sessions" className="grid-cols-3">
        <div className="col-span-3">
          <Field label="Ordner für neue Projekte" hint="Hier legt FORGE neue und geklonte Projekte an.">
            <div className="flex gap-2">
              <Input value={s.defaultProjectDir ?? ""} readOnly placeholder="nicht gesetzt" className="font-mono text-xs" />
              <Button
                onClick={async () => {
                  try {
                    const p = await pickFolder("Ordner für neue Projekte wählen", s.defaultProjectDir);
                    if (p) saveNow({ defaultProjectDir: p });
                  } catch (e) {
                    toast.error("Ordnerdialog fehlgeschlagen", errorMessage(e));
                  }
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" /> Wählen
              </Button>
            </div>
          </Field>
        </div>
        <Field label="Profil" hint={PROFILE_INFO[s.defaultProfile].description}>
          <Select<ProfileId>
            value={s.defaultProfile}
            onChange={(v) => saveNow({ defaultProfile: v })}
            options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
            aria-label="Profil für neue Projekte"
          />
        </Field>
        <Field label="Modell">
          <Select value={toChoice(s.defaultModel)} onChange={(v) => saveNow({ defaultModel: fromChoice(v) })} options={modelOptions(models, "Claude-Code-Standard")} aria-label="Modell für neue Sessions" />
        </Field>
        <Field label="Denkaufwand">
          <Select value={toChoice(s.defaultEffort)} onChange={(v) => saveNow({ defaultEffort: fromChoice<EffortLevel>(v) })} options={effortOptions("Claude-Code-Standard")} aria-label="Denkaufwand" />
        </Field>
      </BasicsGroup>

      <BasicsGroup title="Git">
        {gitMissing ? (
          <p className="col-span-2 text-xs text-warning">Git ist auf diesem PC nicht erreichbar. Name und E-Mail für Commits legst du später unter Einstellungen, GitHub fest.</p>
        ) : loadingIdentity || !identity ? (
          <SkeletonRegion label="Lädt Git-Name und E-Mail" className="col-span-2 grid grid-cols-2 gap-4">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </SkeletonRegion>
        ) : (
          <>
            <Field label="Git-Name" hint="Steht als Autor in deinen Commits.">
              <Input value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} placeholder="Vorname Nachname" />
            </Field>
            <Field label="Git-E-Mail">
              <Input value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} placeholder="du@example.com" type="email" />
            </Field>
          </>
        )}
      </BasicsGroup>
    </div>
  );
}

function BasicsGroup({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className={cn("grid grid-cols-2 items-start gap-4 rounded-lg border border-border bg-surface-2/40 p-4", className)}>{children}</div>
    </section>
  );
}

const PROJECT_STARTS: { mode: NewProjectMode; Icon: typeof FolderOpen; label: string; text: string }[] = [
  { mode: "import", Icon: FolderOpen, label: "Ordner importieren", text: "Ein vorhandenes Projekt auf diesem PC" },
  { mode: "create", Icon: FolderPlus, label: "Neu anlegen", text: "Leerer Ordner, Claude baut den Rest" },
  { mode: "clone", Icon: GitBranch, label: "Repository klonen", text: "Von GitHub oder einer Git-URL" },
];

function DoneStep({ s, claudeReady, onProject }: { s: Settings; claudeReady: boolean | null; onProject: (mode: NewProjectMode) => void }) {
  const st = useSyncStatus().data;
  const account = useGitHubAccount();
  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionTitle>Erstes Projekt</SectionTitle>
        <div className="grid grid-cols-3 gap-3">
          {PROJECT_STARTS.map(({ mode, Icon, label, text }) => (
            <button
              key={mode}
              type="button"
              onClick={() => onProject(mode)}
              className="group flex flex-col items-start gap-2.5 rounded-lg border border-border bg-surface-2/40 p-3.5 text-left transition-colors duration-120 hover:border-accent/60 hover:bg-accent-soft"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-surface-3 text-muted transition-colors duration-120 group-hover:text-accent">
                <Icon className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-body font-medium">{label}</span>
                <span className="mt-0.5 block text-small text-muted">{text}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {s.syncEnabled && st && st.available.length > 0 && (
        <section>
          <SectionTitle>Von deinen anderen PCs</SectionTitle>
          <SyncAvailableList st={st} projectDir={s.defaultProjectDir} />
        </section>
      )}

      <section>
        <SectionTitle>Eingerichtet</SectionTitle>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2/40">
          <SummaryRow label="Claude Code" ok={claudeReady} value={claudeReady === null ? null : claudeReady ? "Angemeldet" : "Noch nicht angemeldet"} />
          <SummaryRow label="GitHub" ok={account.isPending ? null : !!account.data} value={account.isPending ? null : account.data ? `Verbunden als ${account.data.login}` : "Nicht verbunden"} />
          <SummaryRow label="Synchronisierung" ok={s.syncEnabled} value={s.syncEnabled ? "An" : "Aus"} />
          <SummaryRow label="Projektordner" ok={!!s.defaultProjectDir} value={s.defaultProjectDir ?? "Nicht gesetzt"} mono={!!s.defaultProjectDir} />
        </ul>
      </section>
    </div>
  );
}

/** ok and value null: still loading */
function SummaryRow({ label, ok, value, mono = false }: { label: string; ok: boolean | null; value: string | null; mono?: boolean }) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      {ok === null ? (
        <Skeleton className="h-4 w-4 rounded-full" />
      ) : ok ? (
        <CircleCheck className="h-4 w-4 shrink-0 text-success" />
      ) : (
        <CircleDashed className="h-4 w-4 shrink-0 text-subtle" />
      )}
      <span className="text-body">{label}</span>
      {value === null ? (
        <Skeleton className="ml-auto h-3 w-28" />
      ) : (
        <span className={cn("ml-auto min-w-0 truncate text-right text-small text-muted", mono && "font-mono")} title={value}>
          {value}
        </span>
      )}
    </li>
  );
}
