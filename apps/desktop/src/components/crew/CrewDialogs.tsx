import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, Link2, Lock, RefreshCw, Save } from "lucide-react";
import { crewWebLink, type Crew, type CrewAcceptTasks, type CrewShareAgents, type CrewTask } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { crewChanged, initials } from "@/lib/crew";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const m = t.crew;
/** Select value for "whoever wants it" (Radix Select allows no empty value). */
const ANYONE = "*";

/** The invite as code and QR code, with a new code on demand (the old one then stops working). */
export function InviteDialog({ crew, open, onOpenChange }: { crew: Crew; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const invite = crew.invite;
  const [qr, setQr] = useState<string | null>(null);

  // No valid code yet (expired, or the crew was joined, not made here): make one when the dialog opens.
  useEffect(() => {
    if (open && !invite && !busy) void renew(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening without a code
  }, [open, invite]);

  useEffect(() => {
    if (!open || !invite) return setQr(null);
    const css = getComputedStyle(document.documentElement);
    const color = { dark: css.getPropertyValue("--color-fg").trim() || "#000000", light: css.getPropertyValue("--color-surface").trim() || "#ffffff" };
    let gone = false;
    // qrcode loads only when a code is shown.
    void import("qrcode")
      // The link: a phone camera opens the crew in the browser, and FORGE takes it like the code.
      .then(({ default: QRCode }) => QRCode.toDataURL(crewWebLink(invite.code), { margin: 1, width: 260, color, errorCorrectionLevel: "L" }))
      .then((url) => !gone && setQr(url))
      .catch(() => !gone && setQr(null));
    return () => {
      gone = true;
    };
  }, [open, invite]);

  async function renew(announce: boolean) {
    setBusy(true);
    try {
      await call("crew.invite", { crewId: crew.id });
      crewChanged(qc, crew);
      if (announce) toast.success(m.newCodeMade);
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const copy = (link: boolean) => {
    if (!invite) return;
    navigator.clipboard
      .writeText(link ? crewWebLink(invite.code) : invite.code)
      .then(() => toast.success(link ? m.linkCopied : m.copied))
      .catch((e: unknown) => toast.error(t.lib.copyFailed, errorMessage(e)));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.inviteTitle}
      description={m.inviteDescription}
      footer={
        <>
          <Button variant="ghost" loading={busy} onClick={() => void renew(true)}>
            <RefreshCw className="h-3.5 w-3.5" /> {m.newCode}
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {m.close}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="relative h-50 w-50 shrink-0 self-center">
          {qr ? (
            <img src={qr} alt={m.qrAlt} width={200} height={200} className="rounded-lg border border-border" />
          ) : (
            <SkeletonRegion label={m.loading} className="absolute inset-0">
              <Skeleton className="h-full w-full rounded-lg" />
            </SkeletonRegion>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {invite ? (
            <>
              <code className="max-h-28 select-all overflow-y-auto break-all rounded-md border border-border bg-bg/60 p-2 font-mono text-[11px] leading-snug text-fg" data-testid="crew-invite-code">
                {invite.code}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => copy(false)}>
                  <Copy className="h-3.5 w-3.5" /> {m.copyCode}
                </Button>
                <Button size="sm" variant="outline" onClick={() => copy(true)} data-testid="crew-invite-link">
                  <Link2 className="h-3.5 w-3.5" /> {m.copyLink}
                </Button>
                <span className="text-xs text-subtle" title={new Date(invite.expiresAt).toLocaleString()}>
                  {m.expires(relativeTime(invite.expiresAt))}
                </span>
              </div>
            </>
          ) : (
            <SkeletonRegion label={m.loading} className="flex flex-col gap-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-7 w-32" />
            </SkeletonRegion>
          )}
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Globe className="mt-px h-3.5 w-3.5 shrink-0" /> {m.webHint}
          </p>
          <p className="flex items-start gap-1.5 text-xs text-muted">
            <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-success" /> {m.security}
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/** A new task or changes to one: title, details and who should do it. */
export function TaskDialog({
  crew,
  task,
  assignee: initialAssignee,
  open,
  onOpenChange,
}: {
  crew: Crew;
  task: CrewTask | null;
  /** preselected member for a new task */
  assignee?: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [assignee, setAssignee] = useState<string>(ANYONE);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDetail(task?.detail ?? "");
    setAssignee(task?.assignee ?? initialAssignee ?? ANYONE);
  }, [open, task, initialAssignee]);
  const options = [{ value: ANYONE, label: m.anyone }, ...crew.members.map((x) => ({ value: x.id, label: x.self ? `${x.name} (${m.you})` : x.name }))];
  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (task) {
        await call("crew.taskUpdate", { crewId: crew.id, taskId: task.id, title: title.trim(), detail, assignee: assignee === ANYONE ? null : assignee });
        toast.success(m.taskSaved);
      } else {
        await call("crew.taskAdd", { crewId: crew.id, title: title.trim(), detail: detail || undefined, assignee: assignee === ANYONE ? null : assignee });
        toast.success(m.taskAdded);
      }
      crewChanged(qc, crew);
      onOpenChange(false);
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={task ? m.editTaskTitle : m.addTaskTitle}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {m.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={() => void save()}>
            <Save className="h-3.5 w-3.5" /> {m.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={m.taskTitle}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={m.taskTitlePlaceholder}
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
          />
        </Field>
        <Field label={m.taskDetail}>
          <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={4} placeholder={m.taskDetailPlaceholder} maxLength={4000} />
        </Field>
        <Field label={m.taskAssignee}>
          <Select value={assignee} onChange={setAssignee} options={options} aria-label={m.taskAssignee} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Crew name, what happens with tasks others give us, and taking over their pushes. */
export function CrewSettingsDialog({ crew, open, onOpenChange }: { crew: Crew; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(crew.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(crew.name);
  }, [open, crew.name]);
  const update = async (patch: { name?: string; acceptTasks?: CrewAcceptTasks; autoPull?: boolean; shareAgents?: CrewShareAgents }) => {
    try {
      await call("crew.update", { crewId: crew.id, ...patch });
      crewChanged(qc, crew);
      if (patch.name) toast.success(m.renamed);
      else toast.saved();
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    }
  };
  const rename = async () => {
    if (!name.trim() || name.trim() === crew.name) return;
    setBusy(true);
    await update({ name: name.trim() });
    setBusy(false);
  };
  const options = (["auto", "ask", "off"] as const).map((v) => ({ value: v, label: m.acceptTasksOptions[v].label, description: m.acceptTasksOptions[v].description }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.settingsTitle}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {m.close}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={m.createName}>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} onKeyDown={(e) => e.key === "Enter" && void rename()} />
            <Button variant="outline" loading={busy} disabled={!name.trim() || name.trim() === crew.name} onClick={() => void rename()}>
              {m.rename}
            </Button>
          </div>
        </Field>
        <Field label={m.acceptTasks}>
          <Select value={crew.acceptTasks} onChange={(v) => void update({ acceptTasks: v })} options={options} aria-label={m.acceptTasks} />
        </Field>
        <Field label={m.shareAgents}>
          <Select
            value={crew.shareAgents}
            onChange={(v) => void update({ shareAgents: v })}
            options={(["ask", "auto", "off"] as const).map((v) => ({ value: v, label: m.shareAgentsOptions[v].label, description: m.shareAgentsOptions[v].description }))}
            aria-label={m.shareAgents}
          />
        </Field>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-body text-fg">{m.autoPull}</div>
            <div className="text-xs text-muted">{m.autoPullDescription}</div>
          </div>
          <Switch checked={crew.autoPull} onChange={(v) => void update({ autoPull: v })} label={m.autoPull} />
        </div>
      </div>
    </Dialog>
  );
}

/** Round avatar with the member's initials in its color; a dot shows whether it is online. */
export function MemberAvatar({ name, color, online, size = 28, className }: { name: string; color: string; online?: boolean; size?: number; className?: string }) {
  // Two letters only fit from 26 px on; smaller avatars (header, feed) show one.
  const letters = size < 26 ? initials(name).slice(0, 1) : initials(name);
  return (
    <span className={cn("relative inline-flex shrink-0 rounded-full", className)} style={{ width: size, height: size }}>
      <span
        className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
        style={{ background: color, fontSize: Math.round(size * (letters.length > 1 ? 0.38 : 0.46)) }}
        aria-hidden
      >
        {letters}
      </span>
      {online !== undefined && (
        <span
          className={cn("absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full border-2 border-surface", online ? "bg-success" : "bg-subtle")}
          aria-hidden
        />
      )}
    </span>
  );
}
