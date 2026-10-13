import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, FolderOpen, FolderPlus } from "lucide-react";
import type { EffortLevel, ProfileId, Settings } from "@forge/protocol";
import { call, keys, useDiagnostics, useGitHubAccount, useGitIdentity, useRuntimeInfo, useSettings, useSyncProbe, useSyncStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { ClaudeSetupCard } from "@/components/settings/ClaudeSetupCard";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { SyncAvailableList } from "@/components/settings/SyncSettings";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { SyncOffer, useEnableSync, useNeedsPassphrase } from "./SyncOffer";

const STEPS = ["Willkommen", "Claude Code", "GitHub", "Grundlagen", "Los geht's"] as const;

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
  const git = useGitIdentity(step >= 3);
  useAutoOpenGitHub();
  useEffect(() => {
    if (git.data && !identity) setIdentity({ name: git.data.name ?? "", email: git.data.email ?? "" });
  }, [git.data, identity]);

  const save = async (patch: Partial<Settings>) => {
    qc.setQueryData(keys.settings, await call("settings.update", patch));
  };

  const finish = async (then?: () => void) => {
    try {
      await save({ setupDone: true });
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
          await enableSync(passphrase);
        } else await save({ syncEnabled: false, syncAsked: true });
      }
      if (step === 3 && identity && git.data) {
        const name = identity.name.trim();
        const email = identity.email.trim();
        if (name && email && (name !== git.data.name || email !== git.data.email)) qc.setQueryData(keys.gitIdentity, await call("git.setIdentity", { name, email }));
      }
      setStep((x) => Math.min(x + 1, STEPS.length - 1));
    } catch (e) {
      toast.error(step === 2 ? "Synchronisieren fehlgeschlagen" : "Nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const last = step === STEPS.length - 1;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && void finish()}
      title="FORGE einrichten"
      description="Alles lässt sich später unter Einstellungen ändern."
      className="w-170"
      overlayClassName="backdrop-blur-sm"
      bodyClassName="flex min-h-96 flex-col gap-4"
      footer={
        <>
          {!last && (
            <Button variant="ghost" className="mr-auto" onClick={() => void finish()}>
              Überspringen
            </Button>
          )}
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep((x) => x - 1)} disabled={busy}>
              <ArrowLeft className="h-3.5 w-3.5" /> Zurück
            </Button>
          )}
          {last ? (
            <>
              <Button onClick={() => void finish(() => setNewProject("create"))}>
                <FolderPlus className="h-3.5 w-3.5" /> Projekt anlegen
              </Button>
              <Button variant="primary" onClick={() => void finish()}>
                <Check className="h-3.5 w-3.5" /> Fertig
              </Button>
            </>
          ) : (
            <Button variant="primary" loading={busy} onClick={() => void next()}>
              {step === 0 ? "Los" : "Weiter"} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      }
    >
      <ol className="flex gap-1.5" aria-label="Schritte">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined} className="flex flex-1 flex-col gap-1.5">
            <span className={cn("h-1 rounded-full", i <= step ? "bg-accent" : "bg-surface-3")} />
            <span className={cn("text-caption", i === step ? "text-fg" : "text-subtle")}>{label}</span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="flex flex-col gap-3 text-body">
          <p>FORGE arbeitet mit Claude Code und deinem Claude-Abo. Du steuerst darin Projekte, Sessions, Git und parallele Agenten.</p>
          <p className="text-muted">In vier kurzen Schritten: Claude Code anmelden, GitHub verbinden, Ordner und Standards festlegen.</p>
        </div>
      )}

      {step === 1 && <ClaudeStep />}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-body text-muted">Optional. Für private Repositories, Pull Requests und damit FORGE auf deinen anderen PCs dieselben Daten hat.</p>
          <GitHubStep />
          <SyncOffer checked={sync && !!account.data} onChange={setSync} onPassphrase={setPassphrase} />
        </div>
      )}

      {step === 3 && <BasicsStep s={s} save={save} identity={identity} setIdentity={setIdentity} loadingIdentity={git.isLoading} />}

      {step === 4 && <DoneStep s={s} />}
    </Dialog>
  );
}

function ClaudeStep() {
  const d = useDiagnostics().data;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">
        {d?.claude.found && d.auth.loggedIn ? "Alles bereit." : "Fehlt Claude Code, installiert FORGE es selbst. Danach meldest du dich mit deinem Claude-Konto an."}
      </p>
      <div className="rounded-lg border border-border p-4">
        <ClaudeSetupCard />
      </div>
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
}: {
  s: Settings;
  save: (patch: Partial<Settings>) => Promise<void>;
  identity: { name: string; email: string } | null;
  setIdentity: (v: { name: string; email: string }) => void;
  loadingIdentity: boolean;
}) {
  const models = useRuntimeInfo().data?.models ?? [];
  const saveNow = (patch: Partial<Settings>) => void save(patch).catch((e: unknown) => toast.error("Einstellung nicht gespeichert", errorMessage(e)));
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="col-span-2">
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
      <Field label="Profil für neue Projekte" hint={PROFILE_INFO[s.defaultProfile].description}>
        <Select<ProfileId>
          value={s.defaultProfile}
          onChange={(v) => saveNow({ defaultProfile: v })}
          options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
          aria-label="Profil für neue Projekte"
        />
      </Field>
      <Field label="Modell für neue Sessions">
        <Select value={toChoice(s.defaultModel)} onChange={(v) => saveNow({ defaultModel: fromChoice(v) })} options={modelOptions(models, "Claude-Code-Standard")} aria-label="Modell für neue Sessions" />
      </Field>
      <Field label="Denkaufwand">
        <Select value={toChoice(s.defaultEffort)} onChange={(v) => saveNow({ defaultEffort: fromChoice<EffortLevel>(v) })} options={effortOptions("Claude-Code-Standard")} aria-label="Denkaufwand" />
      </Field>
      <div />
      {loadingIdentity || !identity ? (
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
    </div>
  );
}

function DoneStep({ s }: { s: Settings }) {
  const st = useSyncStatus().data;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body">FORGE ist eingerichtet. Lege ein Projekt an, importiere einen Ordner oder klone ein Repository.</p>
      {s.syncEnabled && st && st.available.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-body text-muted">Diese Projekte kommen von deinen anderen PCs. Hol sie mit einem Klick hierher:</p>
          <SyncAvailableList st={st} projectDir={s.defaultProjectDir} />
        </div>
      )}
    </div>
  );
}
