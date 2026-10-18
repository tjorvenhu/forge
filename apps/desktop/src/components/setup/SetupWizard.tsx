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
import { LanguageChoice } from "@/components/settings/LanguageSelect";
import { t } from "@/i18n";
import { SyncOffer, useEnableSync, useNeedsPassphrase } from "./SyncOffer";

const ts = t.setup;

const STEPS = [
  { ...ts.steps.welcome, Icon: Sparkles },
  // the lead of this step says whether Claude Code is ready
  { ...ts.steps.claude, Icon: SquareTerminal, lead: "" },
  { ...ts.steps.github, Icon: Cloud },
  { ...ts.steps.basics, Icon: SlidersHorizontal },
  { ...ts.steps.done, Icon: Rocket },
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
      toast.error(ts.notFinished, errorMessage(e));
    }
  };

  /** Leaving a step saves what it asked; the sync runs before the defaults, so they show what came from GitHub. */
  const next = async () => {
    setBusy(true);
    try {
      if (step === 2 && account.data) {
        if (sync) {
          if (needsPassphrase && !passphrase) throw new Error(ts.passphraseFirst);
          const firstSync = await enableSync(passphrase);
          // Switched on all the same; the next sync tries again, the assistant goes on.
          if (firstSync) toast.info(ts.syncOn, ts.firstSyncFailed(firstSync));
        } else await save({ syncEnabled: false, syncAsked: true });
      }
      if (step === 3 && identity && filledFrom) {
        const name = identity.name.trim();
        const email = identity.email.trim();
        if (name && email && (name !== filledFrom.name || email !== filledFrom.email)) qc.setQueryData(keys.gitIdentity, await call("git.setIdentity", { name, email }));
      }
      setStep((x) => Math.min(x + 1, STEPS.length - 1));
    } catch (e) {
      toast.error(step === 2 ? ts.syncFailed : ts.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;
  const meta = STEPS[step]!;
  const claudeReady = !!diagnostics.data?.claude.found && !!diagnostics.data.auth.loggedIn;
  const lead = step === 1 ? (claudeReady ? ts.claudeReady : ts.claudeMissing) : meta.lead;
  return (
    <Dialog
      open
      hideHeader
      onOpenChange={(o) => !o && void finish()}
      title={ts.title}
      description={ts.changeLater}
      className="h-150 w-220"
    >
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg/50 px-5 pb-5 pt-6">
          <Logo height={26} />
          <ol aria-label={ts.stepsLabel} className="mt-9 flex flex-col">
            {STEPS.map((x, i) => (
              <StepItem key={x.label} label={x.label} hint={x.hint} index={i} step={step} last={i === STEPS.length - 1} onClick={busy || i >= step ? undefined : () => setStep(i)} />
            ))}
          </ol>
          <p className="mt-auto text-caption text-subtle">{ts.changeLater}</p>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-start gap-3.5 px-7 pb-5 pt-7">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <meta.Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-caption text-subtle">
                {ts.stepOf(step + 1, STEPS.length)}
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
                {ts.skip}
              </Button>
            )}
            {step > 0 && (
              <Button variant="ghost" className={cn(last && "mr-auto")} onClick={() => setStep((x) => x - 1)} disabled={busy}>
                <ArrowLeft className="h-3.5 w-3.5" /> {ts.back}
              </Button>
            )}
            {last ? (
              <Button variant="primary" onClick={() => void finish()}>
                <Check className="h-3.5 w-3.5" /> {ts.finish}
              </Button>
            ) : (
              <Button variant="primary" loading={busy} disabled={probing} onClick={() => void next()} autoFocus>
                {step === 0 ? ts.start : ts.next} <ArrowRight className="h-3.5 w-3.5" />
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
  { Icon: FolderKanban, ...ts.features.projects },
  { Icon: GitBranch, ...ts.features.git },
  { Icon: Bot, ...ts.features.agents },
  { Icon: Phone, ...ts.features.phone },
];

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>{t.setup.languageTitle}</SectionTitle>
        <LanguageChoice />
      </section>
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
      <p className="text-small text-subtle">{ts.nextUp}</p>
    </div>
  );
}

function GitHubStep() {
  const gh = useDiagnostics().data?.gh;
  return (
    <div className="rounded-lg border border-border p-4">
      {gh && !gh.found ? <p className="text-body text-danger">{ts.githubMissing}</p> : <GitHubAccountCard />}
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
  const saveNow = (patch: Partial<Settings>) => void save(patch).catch((e: unknown) => toast.error(ts.basics.settingNotSaved, errorMessage(e)));
  return (
    <div className="flex flex-col gap-5">
      <BasicsGroup title={ts.basics.projectsTitle} className="grid-cols-3">
        <div className="col-span-3">
          <Field label={ts.basics.projectDir} hint={ts.basics.projectDirHint}>
            <div className="flex gap-2">
              <Input value={s.defaultProjectDir ?? ""} readOnly placeholder={ts.basics.notSet} className="font-mono text-xs" />
              <Button
                onClick={async () => {
                  try {
                    const p = await pickFolder(ts.basics.pickProjectDir, s.defaultProjectDir);
                    if (p) saveNow({ defaultProjectDir: p });
                  } catch (e) {
                    toast.error(ts.basics.folderDialogFailed, errorMessage(e));
                  }
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" /> {ts.basics.choose}
              </Button>
            </div>
          </Field>
        </div>
        <Field label={ts.basics.profile} hint={PROFILE_INFO[s.defaultProfile].description}>
          <Select<ProfileId>
            value={s.defaultProfile}
            onChange={(v) => saveNow({ defaultProfile: v })}
            options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
            aria-label={ts.basics.profileAria}
          />
        </Field>
        <Field label={ts.basics.model}>
          <Select value={toChoice(s.defaultModel)} onChange={(v) => saveNow({ defaultModel: fromChoice(v) })} options={modelOptions(models, ts.basics.claudeDefault)} aria-label={ts.basics.modelAria} />
        </Field>
        <Field label={ts.basics.effort}>
          <Select value={toChoice(s.defaultEffort)} onChange={(v) => saveNow({ defaultEffort: fromChoice<EffortLevel>(v) })} options={effortOptions(ts.basics.claudeDefault)} aria-label={ts.basics.effort} />
        </Field>
      </BasicsGroup>

      <BasicsGroup title={ts.basics.gitTitle}>
        {gitMissing ? (
          <p className="col-span-2 text-xs text-warning">{ts.basics.gitMissing}</p>
        ) : loadingIdentity || !identity ? (
          <SkeletonRegion label={ts.basics.loadingIdentity} className="col-span-2 grid grid-cols-2 gap-4">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </SkeletonRegion>
        ) : (
          <>
            <Field label={ts.basics.gitName} hint={ts.basics.gitNameHint}>
              <Input value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} placeholder={ts.basics.gitNamePlaceholder} />
            </Field>
            <Field label={ts.basics.gitEmail}>
              <Input value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} placeholder={ts.basics.gitEmailPlaceholder} type="email" />
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
  { mode: "import", Icon: FolderOpen, ...ts.doneStep.starts.import },
  { mode: "create", Icon: FolderPlus, ...ts.doneStep.starts.create },
  { mode: "clone", Icon: GitBranch, ...ts.doneStep.starts.clone },
];

function DoneStep({ s, claudeReady, onProject }: { s: Settings; claudeReady: boolean | null; onProject: (mode: NewProjectMode) => void }) {
  const st = useSyncStatus().data;
  const account = useGitHubAccount();
  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionTitle>{ts.doneStep.firstProject}</SectionTitle>
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
          <SectionTitle>{ts.doneStep.fromOtherPcs}</SectionTitle>
          <SyncAvailableList st={st} projectDir={s.defaultProjectDir} />
        </section>
      )}

      <section>
        <SectionTitle>{ts.doneStep.summary}</SectionTitle>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2/40">
          <SummaryRow label="Claude Code" ok={claudeReady} value={claudeReady === null ? null : claudeReady ? ts.doneStep.signedIn : ts.doneStep.notSignedIn} />
          <SummaryRow label="GitHub" ok={account.isPending ? null : !!account.data} value={account.isPending ? null : account.data ? ts.doneStep.connectedAs(account.data.login) : ts.doneStep.notConnected} />
          <SummaryRow label={ts.doneStep.sync} ok={s.syncEnabled} value={s.syncEnabled ? ts.doneStep.on : ts.doneStep.off} />
          <SummaryRow label={ts.doneStep.projectDir} ok={!!s.defaultProjectDir} value={s.defaultProjectDir ?? ts.doneStep.notSet} mono={!!s.defaultProjectDir} />
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
