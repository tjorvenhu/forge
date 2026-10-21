import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  FileStack,
  FileText,
  FolderOpen,
  Info,
  Phone,
  Cloud,
  RefreshCw,
  ShieldAlert,
  ShieldBan,
  SlidersHorizontal,
  SquareTerminal,
  Volume2,
  XCircle,
} from "lucide-react";
import { PUBLISHER, STATS_PAGE_URL, type Diagnostics, type ProfileId, type Settings, type ToolCheck, type EffortLevel } from "@forge/protocol";
import { call, keys, useDiagnostics, useRuntimeInfo, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal, pickFolder } from "@/lib/native";
import { playSound } from "@/lib/sounds";
import { toast } from "@/stores/toast";
import { useUi, type SettingsSection } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { FormSkeleton, Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Group, Row, SettingsLayout, SwitchRow, type SettingsSectionDef } from "@/components/settings/layout";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { ClaudeSetupCard } from "@/components/settings/ClaudeSetupCard";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { MemoryEditor } from "@/components/settings/MemoryEditor";
import { ScreenshotKeyRow } from "@/components/screenshot/ScreenshotKeyRow";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";
import { idleCloseOptions } from "@/components/settings/idle-close";
import { longSessionOptions } from "@/components/workspace/handoff";
import { PhoneSettings } from "@/components/settings/PhoneSettings";
import { BackupSettings } from "@/components/settings/BackupSettings";
import { SyncSettings } from "@/components/settings/SyncSettings";
import { GitHubVersions } from "@/components/settings/BackupSettings";
import { PolicySettings } from "@/components/settings/PolicySettings";
import { TemplatesSettings } from "@/components/templates/TemplatesSettings";
import { GitHubSettings } from "@/components/settings/GitHubSettings";
import { AppUpdateSettings } from "@/components/layout/AppUpdate";
import { DevChannelSettings } from "@/components/settings/DevChannelSettings";
import { InstallRepairSettings } from "@/components/layout/InstallRepair";
import { supportsFullInstall } from "@/lib/app-install";
import { LanguageSelect } from "@/components/settings/LanguageSelect";
import { cn, planLabel } from "@/lib/utils";
import { t } from "@/i18n";

const sv = t.views.settings;

type Save = (patch: Partial<Settings>) => Promise<void>;

export const SECTIONS: ReadonlyArray<SettingsSectionDef<SettingsSection>> = [
  { id: "general", label: sv.sections.general.label, hint: sv.sections.general.hint, Icon: SlidersHorizontal },
  { id: "templates", label: sv.sections.templates.label, hint: sv.sections.templates.hint, Icon: FileStack },
  { id: "claude", label: sv.sections.claude.label, hint: sv.sections.claude.hint, Icon: SquareTerminal },
  { id: "policy", label: sv.sections.policy.label, hint: sv.sections.policy.hint, Icon: ShieldBan },
  { id: "phone", label: sv.sections.phone.label, hint: sv.sections.phone.hint, Icon: Phone },
  { id: "github", label: sv.sections.github.label, hint: sv.sections.github.hint, Icon: Cloud },
  { id: "backup", label: sv.sections.backup.label, hint: sv.sections.backup.hint, Icon: ArchiveRestore },
  { id: "rules", label: sv.sections.rules.label, hint: sv.sections.rules.hint, Icon: FileText },
  { id: "about", label: sv.sections.about.label, hint: sv.sections.about.hint, Icon: Info },
];

export function SettingsView() {
  const settings = useSettings();
  const section = useUi((s) => s.settingsSection);
  const openSettings = useUi((s) => s.openSettings);
  const qc = useQueryClient();

  const save: Save = async (patch) => {
    try {
      const next = await call("settings.update", patch);
      qc.setQueryData(keys.settings, next);
      void qc.invalidateQueries({ queryKey: keys.diagnostics });
      toast.saved();
    } catch (e) {
      toast.error(sv.saveFailed, errorMessage(e));
    }
  };

  const s = settings.data;
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]!;
  return (
    <Page title={sv.title} subtitle={sv.subtitle}>
      <SettingsLayout sections={SECTIONS} current={current.id} onSelect={openSettings} label={sv.sectionsLabel}>
        {!s ? (
          <FormSkeleton groups={2} label={sv.loading} />
        ) : current.id === "general" ? (
          <GeneralSection s={s} save={save} />
        ) : current.id === "templates" ? (
          <TemplatesSettings />
        ) : current.id === "claude" ? (
          <ClaudeSection s={s} save={save} />
        ) : current.id === "policy" ? (
          <PolicySettings s={s} save={save} />
        ) : current.id === "phone" ? (
          <PhoneSection />
        ) : current.id === "github" ? (
          <GitHubSection s={s} save={save} />
        ) : current.id === "backup" ? (
          <Group
            title={sv.backupTitle}
            description={sv.backupDescription}
          >
            <div className="p-4">
              <BackupSettings />
            </div>
          </Group>
        ) : current.id === "rules" ? (
          <Group title={sv.rulesTitle} description={sv.rulesDescription}>
            <div className="p-4">
              <MemoryEditor scopes={["global"]} />
            </div>
          </Group>
        ) : (
          <AboutSection s={s} save={save} />
        )}
      </SettingsLayout>
    </Page>
  );
}

function GeneralSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group title={sv.newSessionsTitle} description={sv.newSessionsDescription}>
        <ModelSetting value={s.defaultModel} onChange={(v) => void save({ defaultModel: v })} />
        <Row label={sv.effortLabel} description={sv.effortDescription}>
          <Select
            value={toChoice(s.defaultEffort)}
            onChange={(v) => void save({ defaultEffort: fromChoice<EffortLevel>(v) })}
            className="w-64"
            options={effortOptions(sv.claudeCodeDefault)}
          />
        </Row>
        <Row label={sv.profileForNewProjects} description={PROFILE_INFO[s.defaultProfile].description}>
          <Select<ProfileId>
            value={s.defaultProfile}
            onChange={(v) => void save({ defaultProfile: v })}
            className="w-64"
            options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
          />
        </Row>
        {s.defaultProfile === "autonomous" && (
          <div className="flex items-start gap-3 bg-danger-soft/40 px-4 py-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p className="text-xs text-muted">
              {sv.autonomousWarning}
            </p>
          </div>
        )}
        <Row label={sv.projectDirLabel} description={sv.projectDirDescription} stacked>
          <div className="flex gap-2">
            <Input value={s.defaultProjectDir ?? ""} readOnly placeholder={sv.notSet} className="font-mono text-xs" />
            <Button
              onClick={async () => {
                try {
                  const p = await pickFolder(sv.pickProjectDir, s.defaultProjectDir);
                  if (p) void save({ defaultProjectDir: p });
                } catch (e) {
                  toast.error(sv.folderDialogFailed, errorMessage(e));
                }
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" /> {sv.choose}
            </Button>
          </div>
        </Row>
      </Group>


      <Group title={sv.controlsTitle}>
        <Row label={t.settings.language} description={t.settings.languageHint}>
          <LanguageSelect className="w-64" />
        </Row>
        <SwitchRow
          label={sv.enterSends}
          description={s.enterToSend ? sv.enterSendsOn : sv.enterSendsOff}
          checked={s.enterToSend}
          onChange={(v) => void save({ enterToSend: v })}
        />
        <SwitchRow
          label={sv.notificationsLabel}
          description={sv.notificationsDescription}
          checked={s.desktopNotifications}
          onChange={(v) => void save({ desktopNotifications: v })}
        />
        <SwitchRow
          label={sv.alwaysOnTopLabel}
          description={sv.alwaysOnTopDescription}
          checked={s.alwaysOnTop}
          onChange={(v) => void save({ alwaysOnTop: v })}
        />
        <ScreenshotKeyRow checked={s.screenshotKey} onChange={(v) => void save({ screenshotKey: v })} />
        <SwitchRow
          label={sv.askPushOnCloseLabel}
          description={sv.askPushOnCloseDescription}
          checked={s.askPushOnClose}
          onChange={(v) => void save({ askPushOnClose: v })}
        />
        <Row label={sv.soundsLabel} description={sv.soundsDescription}>
          <div className="flex items-center gap-1">
            {(["done", "approval", "error"] as const).map((k) => (
              <Button key={k} size="icon-sm" variant="ghost" onClick={() => playSound(k)} aria-label={sv.soundPlay(SOUND_LABEL[k])} title={sv.soundPlay(SOUND_LABEL[k])}>
                <Volume2 className="h-3.5 w-3.5" />
              </Button>
            ))}
            <span className="ml-2">
              <Switch checked={s.sounds} onChange={(v) => void save({ sounds: v })} label={sv.soundsLabel} />
            </span>
          </div>
        </Row>
      </Group>
    </>
  );
}

const SOUND_LABEL = { done: sv.soundDone, approval: sv.soundApproval, error: sv.soundError } as const;

export function ModelSetting({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const info = useRuntimeInfo();
  const models = info.data?.models ?? [];
  const hint = info.isLoading ? sv.modelLoading : models.length ? sv.modelHint : sv.modelUnavailable;
  return (
    <Row label={sv.modelLabel} description={hint}>
      <Select value={toChoice(value)} onChange={(v) => onChange(fromChoice(v))} className="w-64" options={modelOptions(models, sv.claudeCodeDefault)} />
    </Row>
  );
}

function ClaudeSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group
        title={sv.installTitle}
        description={sv.installDescription}
      >
        <div className="px-4 py-3.5">
          <ClaudeSetupCard />
        </div>
      </Group>

      <UsageSettings />

      <Group title={sv.behaviorTitle}>
        <SwitchRow
          label={sv.autoContinueLabel}
          description={sv.autoContinueDescription}
          checked={s.autoContinueAfterLimit}
          onChange={(v) => void save({ autoContinueAfterLimit: v })}
        />
        <SwitchRow
          label={sv.uiCompareLabel}
          description={sv.uiCompareDescription}
          checked={s.uiCompare}
          onChange={(v) => void save({ uiCompare: v })}
        />
        <Row label={sv.idleCloseLabel} description={sv.idleCloseDescription}>
          <Select
            value={String(s.idleCloseMinutes)}
            onChange={(v) => void save({ idleCloseMinutes: Number(v) })}
            className="w-64"
            options={idleCloseOptions(s.idleCloseMinutes)}
            aria-label={sv.idleCloseLabel}
          />
        </Row>
        <Row
          label={sv.longSessionLabel}
          description={sv.longSessionDescription}
        >
          <Select
            value={String(s.longSessionTokens)}
            onChange={(v) => void save({ longSessionTokens: Number(v) })}
            className="w-64"
            options={longSessionOptions(s.longSessionTokens)}
            aria-label={sv.longSessionLabel}
          />
        </Row>
        <SwitchRow
          label={sv.stripKeyLabel}
          description={sv.stripKeyDescription}
          checked={s.stripApiKey}
          onChange={(v) => void save({ stripApiKey: v })}
        />
      </Group>

      <Group title={sv.advancedTitle}>
        <Row label={sv.claudePathLabel} description={sv.claudePathDescription} stacked>
          <ClaudePathInput value={s.claudePath} onSave={(v) => void save({ claudePath: v })} />
        </Row>
      </Group>
    </>
  );
}

/** Saved when the field is left or with Enter, so a half-typed path is never used. */
function ClaudePathInput({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const commit = () => {
    if (draft.trim() !== (value ?? "")) onSave(draft.trim() || null);
  };
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      placeholder={sv.claudePathPlaceholder}
      className="font-mono text-xs"
      aria-label={sv.claudePathLabel}
    />
  );
}

/** Everything with GitHub in one place: the account, the sync and the states it left on GitHub. */
function GitHubSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <GitHubSettings />
      <SyncSettings s={s} save={save} />
      {s.syncEnabled && (
        <Group title={sv.versionsTitle} description={sv.versionsDescription}>
          <div className="p-4">
            <GitHubVersions />
          </div>
        </Group>
      )}
    </>
  );
}

/** The phone settings come as their own cards, one per topic. */
function PhoneSection() {
  return <PhoneSettings />;
}

function AboutSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group title={sv.publisherTitle}>
        <div className="flex flex-col gap-2 px-4 py-3.5 text-body">
          <p>
            {sv.publisherText(PUBLISHER.name, PUBLISHER.license)}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {(
              [
                ["vanturis.de", PUBLISHER.site],
                [sv.linkImprint, PUBLISHER.imprint],
                [sv.linkPrivacy, PUBLISHER.privacy],
                [sv.linkSource, PUBLISHER.source],
              ] as const
            ).map(([label, href]) => (
              <a
                key={href}
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(href);
                }}
                className="underline hover:text-fg"
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      </Group>

      <Group title={sv.updatesTitle}>
        <div className="px-4 py-3.5">
          <AppUpdateSettings />
        </div>
        <SwitchRow
          label={sv.autoUpdateLabel}
          description={sv.autoUpdateDescription}
          checked={s.updateChecks}
          onChange={(v) => void save({ updateChecks: v })}
        />
        <DevChannelSettings s={s} save={save} />
      </Group>

      {supportsFullInstall && (
        <Group title={sv.installationTitle} description={sv.installationDescription}>
          <div className="px-4 py-3.5">
            <InstallRepairSettings />
          </div>
        </Group>
      )}

      <Group title={sv.privacyTitle}>
        <SwitchRow
          label={sv.usageStatsLabel}
          description={
            <>
              {sv.usageStatsText}{" "}
              <a
                href={STATS_PAGE_URL}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(STATS_PAGE_URL);
                }}
                className="underline hover:text-fg"
              >
                {sv.usageStatsLink}
              </a>
            </>
          }
          checked={s.usageStats}
          onChange={(v) => void save({ usageStats: v, usageStatsAsked: true })}
        />
        <ul className="list-disc space-y-1.5 py-3.5 pl-9 pr-4 text-body text-muted">
          <li>{sv.privacyLocal}</li>
          <li>{sv.privacyPhone}</li>
          <li>{sv.privacySecrets}</li>
          <li>{sv.privacyCredentials}</li>
        </ul>
      </Group>

      <DiagnosticsPanel />
    </>
  );
}

function DiagnosticsPanel() {
  const diag = useDiagnostics();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(keys.diagnostics, await call("system.diagnostics", { refresh: true }));
    } catch (e) {
      toast.error(sv.diagnosticsFailed, errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  const d = diag.data;
  return (
    <Group
      title={sv.diagnosticsTitle}
      description={sv.diagnosticsDescription}
      action={
        <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing}>
          <RefreshCw className="h-3.5 w-3.5" /> {sv.recheck}
        </Button>
      }
    >
      {diag.isLoading && <DiagnosticsSkeleton />}
      {diag.isError && (
        <div className="p-4">
          <ErrorBanner>{errorMessage(diag.error)}</ErrorBanner>
        </div>
      )}
      {d && (
        <>
          <div className="flex flex-col gap-1.5 px-4 py-3.5 text-body">
            <InfoRow label="System" value={d.platform} />
            <InfoRow label="Node.js (Sidecar)" value={d.nodeVersion} />
            <InfoRow label={sv.dataFolder} value={<span className="block truncate font-mono text-xs" title={d.dataDir}>{d.dataDir}</span>} />
            <ToolRow label="Claude Code" check={d.claude} />
            <AuthRow d={d} />
            <InfoRow
              label="ANTHROPIC_API_KEY"
              value={
                !d.apiKeyEnvPresent ? (
                  <Badge tone="success">{sv.notSet}</Badge>
                ) : d.apiKeyStripped ? (
                  <Badge tone="warning">{sv.keyStripped}</Badge>
                ) : (
                  <Badge tone="danger">{sv.keyActive}</Badge>
                )
              }
            />
            <ToolRow label="git" check={d.git} />
            <ToolRow label="GitHub CLI" check={d.gh} extra={d.gh.found ? (d.gh.authenticated ? <Badge tone="success">{sv.signedIn}</Badge> : <Badge tone="warning">{sv.notSignedIn}</Badge>) : null} />
            <ToolRow label="Python" check={d.python} />
          </div>
          <div className="px-4 py-3.5">
            <div className="mb-2 text-xs font-medium text-muted">{sv.capabilities}</div>
            <div className="divide-y divide-border rounded-lg border border-border">
              {d.capabilities.map((c) => (
                <div key={c.key} className="flex items-start gap-2 px-3 py-1.5 text-body">
                  {c.state === "supported" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : c.state === "partial" ? (
                    <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : (
                    <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                  )}
                  <span className="w-44 shrink-0">{c.label}</span>
                  <span className={cn("min-w-0 flex-1 pt-px text-xs", c.state === "unavailable" ? "text-subtle" : "text-muted")}>{c.note}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Group>
  );
}

/** Same rows and boxes as the loaded diagnostics: nine info rows, then the capability list. */
function DiagnosticsSkeleton() {
  return (
    <SkeletonRegion label={sv.loadingDiagnostics} className="divide-y divide-border">
      <div className="flex flex-col gap-1.5 px-4 py-3.5">
        {[45, 30, 70, 40, 35, 50, 30, 45, 25].map((w, i) => (
          <div key={i} className="flex h-5 items-center gap-3">
            <div className="w-40 shrink-0">
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="px-4 py-3.5">
        <Skeleton className="mb-2 h-3 w-64" />
        <div className="divide-y divide-border rounded-lg border border-border">
          {[55, 40, 65, 35, 50].map((w, i) => (
            <div key={i} className="flex h-8 items-center gap-2 px-3">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
              <div className="w-44 shrink-0">
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-40 shrink-0 py-px text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

function ToolRow({ label, check, extra }: { label: string; check: ToolCheck; extra?: ReactNode }) {
  return (
    <InfoRow
      label={label}
      value={
        check.found ? (
          <span className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            {check.version ?? sv.found}
            {check.bundled ? <Badge tone="accent">{sv.bundled}</Badge> : <Badge>System</Badge>}
            {extra}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-danger">
            <XCircle className="h-3.5 w-3.5" /> {sv.notFound}
          </span>
        )
      }
    />
  );
}

function AuthRow({ d }: { d: Diagnostics }) {
  if (!d.auth.checked) return <InfoRow label={sv.signInLabel} value={<span className="text-subtle">{sv.notChecked}</span>} />;
  if (d.auth.error) return <InfoRow label={sv.signInLabel} value={<span className="text-danger">{d.auth.error}</span>} />;
  return (
    <InfoRow
      label={sv.signInLabel}
      value={
        d.auth.loggedIn ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="success">{sv.signedIn}</Badge>
            <span className="text-muted">
              {d.auth.authMethod === "claude.ai" ? sv.claudeAccount : d.auth.authMethod}
              {d.auth.subscriptionType ? `, ${planLabel(d.auth)}` : ""}
            </span>
          </span>
        ) : (
          <span className="text-danger">{sv.notSignedInHint}</span>
        )
      }
    />
  );
}
