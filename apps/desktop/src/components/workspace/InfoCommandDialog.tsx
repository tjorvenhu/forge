import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextUsage, PermissionMode, Project, Session } from "@forge/protocol";
import { call, keys, useDiagnostics, useRuntimeInfo, useUsage } from "@/lib/queries";
import { useModelLabel } from "@/lib/models";
import { cn, formatTokens, planLabel, relativeTime } from "@/lib/utils";
import { Dialog } from "@/components/ui/dialog";
import { Badge, Loading } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { ProfileBadge } from "@/components/projects/ProfileBadge";
import { contextTone } from "./ContextMeter";
import { compactSession } from "./useSendMessage";
import { useChatSurface } from "./chat-surface";

interface InfoProps {
  project: Project;
  session: Session | null;
  onClose: () => void;
}

/**
 * Slash commands FORGE answers itself with a dialog over the chat, like the panels of /usage or /context
 * in the terminal. A new one only needs an entry here: it shows up in the slash menu and never goes to Claude.
 */
export interface InfoCommand {
  name: string;
  title: string;
  description: string;
  Body: (p: InfoProps) => ReactNode;
}

export const INFO_COMMANDS: InfoCommand[] = [
  { name: "usage", title: "Nutzung", description: "Verbrauch des Claude-Abos in den laufenden Zeitfenstern anzeigen.", Body: UsageBody },
  { name: "context", title: "Kontext", description: "Belegung des Kontextfensters dieser Session anzeigen.", Body: ContextBody },
  { name: "status", title: "Status", description: "Claude Code, Konto, Modell und Session auf einen Blick.", Body: StatusBody },
  { name: "mcp", title: "MCP-Server", description: "MCP-Server und ihren Verbindungsstatus anzeigen.", Body: McpBody },
];

/** The info command typed as the whole input ("/usage"), or null. */
export function infoCommand(text: string): InfoCommand | null {
  const m = /^\/(\w+)$/.exec(text.trim());
  return (m && INFO_COMMANDS.find((c) => c.name === m[1]!.toLowerCase())) || null;
}

/** Opens over the chat and blurs it; closing hands the focus back to the composer (Radix does that). */
export function InfoCommandDialog({ command, project, session, onClose }: { command: InfoCommand | null } & InfoProps) {
  const surface = useChatSurface();
  // The last command stays rendered while the dialog fades out.
  const [shown, setShown] = useState(command);
  if (command && command !== shown) setShown(command);
  const Body = shown?.Body;
  return (
    <Dialog
      open={!!command}
      onOpenChange={(o) => !o && onClose()}
      title={shown?.title ?? ""}
      description={shown ? `/${shown.name}` : undefined}
      container={surface}
      overlayClassName="chat-dialog-overlay bg-overlay/40"
      className="w-140"
    >
      {Body && <Body project={project} session={session} onClose={onClose} />}
    </Dialog>
  );
}

/** Plan windows warn later than the context window, like the bars in the sidebar. */
const usageTone = (pct: number) => (pct >= 95 ? "danger" : pct >= 80 ? "warn" : "ok");

function Meter({ label, value, detail, toneOf }: { label: string; value: number; detail?: string; toneOf: (pct: number) => "ok" | "warn" | "danger" }) {
  const pct = Math.max(0, Math.round(value));
  const tone = toneOf(pct);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-body">
        <span>{label}</span>
        <span className={cn("tabular-nums", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-muted")}>{pct} % genutzt</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={Math.min(100, pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {detail && <div className="mt-1 text-caption text-subtle">{detail}</div>}
    </div>
  );
}

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const resetText = (iso: string | null) =>
  iso ? `Wird ${relativeTime(iso)} zurückgesetzt (${new Date(iso).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })})` : undefined;

function UsageBody() {
  const qc = useQueryClient();
  const usage = useUsage();
  const diag = useDiagnostics();
  // Opening the dialog is a request for the current numbers, not the ones from up to 5 minutes ago.
  useEffect(() => void qc.invalidateQueries({ queryKey: keys.usage }), [qc]);
  if (!usage.data) return <Loading />;
  const plan = diag.data ? planLabel(diag.data.auth) : null;
  if (!usage.data.available)
    return <div className="text-body text-muted">{usage.data.error ?? "Claude Code meldet keine Nutzungsdaten. Sie gibt es nur mit einem Claude-Abo (Pro oder Max)."}</div>;
  return (
    <div className="space-y-4">
      {plan && <div className="text-body text-muted">{plan}</div>}
      {usage.data.windows.map((w) => (
        <Meter key={w.key} label={w.label} value={w.utilization} detail={resetText(w.resetsAt)} toneOf={usageTone} />
      ))}
      <div className="text-caption text-subtle">Stand {relativeTime(usage.data.fetchedAt)}</div>
    </div>
  );
}

function useContextUsage(session: Session | null) {
  return useQuery({
    queryKey: ["contextUsage", session?.id],
    queryFn: () => call("sessions.contextUsage", { sessionId: session!.id }),
    enabled: !!session,
    placeholderData: session?.context ?? undefined,
  });
}

const KIND_LABEL: Record<ContextUsage["categories"][number]["kind"], string> = { used: "Belegt", free: "Frei", buffer: "Reserve", deferred: "Bei Bedarf" };

function ContextBody({ session, onClose }: InfoProps) {
  const ctx = useContextUsage(session);
  if (!session) return <div className="text-body text-muted">Noch keine Session. Die Belegung zeigt sich nach der ersten Antwort.</div>;
  if (ctx.isLoading) return <Loading />;
  const usage = ctx.data;
  if (!usage) return <div className="text-body text-muted">Claude Code hat für diese Session noch keine Belegung gemeldet.</div>;
  const order = { used: 0, deferred: 1, buffer: 2, free: 3 } as const;
  const categories = [...usage.categories].sort((a, b) => order[a.kind] - order[b.kind] || b.tokens - a.tokens);
  return (
    <div className="space-y-4">
      <Meter label="Kontextfenster" value={usage.percentage} detail={`${formatTokens(usage.totalTokens)} von ${formatTokens(usage.maxTokens)} Tokens`} toneOf={contextTone} />
      <table className="w-full text-body">
        <tbody className="divide-y divide-border">
          {categories.map((c) => (
            <tr key={`${c.kind}:${c.name}`}>
              <td className="py-1.5">{c.name}</td>
              <td className="py-1.5 text-caption text-subtle">{KIND_LABEL[c.kind]}</td>
              <td className="py-1.5 text-right tabular-nums text-muted">{formatTokens(c.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {session.live && (
        <div className="flex justify-end">
          <Button
            disabled={session.status !== "idle"}
            title={session.status !== "idle" ? "Geht, sobald Claude mit dem aktuellen Schritt fertig ist" : undefined}
            onClick={() => {
              onClose();
              void compactSession(session.id);
            }}
          >
            Jetzt komprimieren
          </Button>
        </div>
      )}
    </div>
  );
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Jede Aktion freigeben",
  acceptEdits: "Datei-Edits automatisch",
  plan: "Nur planen",
  bypassPermissions: "Ohne Rückfragen",
};

function StatusBody({ project, session }: InfoProps) {
  const diag = useDiagnostics();
  const runtime = useRuntimeInfo();
  const modelLabel = useModelLabel();
  if (!diag.data) return <Loading />;
  const d = diag.data;
  const login = !d.auth.loggedIn ? "Nicht angemeldet" : (planLabel(d.auth) ?? d.auth.authMethod ?? "Angemeldet");
  const mcp = runtime.data?.mcpServers ?? [];
  const rows: Array<[string, ReactNode]> = [
    ["Claude Code", d.claude.found ? (d.claude.version ?? "unbekannte Version") : "nicht gefunden"],
    ["Konto", login],
    ["Projekt", project.name],
    ["Ordner", <span className="font-mono text-small">{session?.cwd ?? project.path}</span>],
    ["Profil", <ProfileBadge profile={session?.profile ?? project.profile} />],
  ];
  if (session) {
    rows.push(
      ["Modell", session.model ? modelLabel(session.model) : "Standard"],
      ["Effort", session.effort ?? "Standard"],
      ["Modus", MODE_LABEL[session.permissionMode]],
      ["Session-ID", <span className="font-mono text-small">{session.claudeSessionId ?? "noch keine"}</span>],
    );
  }
  rows.push(["MCP-Server", mcp.length ? `${mcp.filter((s) => s.status === "connected").length} von ${mcp.length} verbunden` : "keine gemeldet"]);
  return <Rows rows={rows} />;
}

const MCP_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  connected: { label: "Verbunden", tone: "success" },
  pending: { label: "Verbindet", tone: "neutral" },
  "needs-auth": { label: "Anmeldung nötig", tone: "warning" },
  failed: { label: "Fehlgeschlagen", tone: "danger" },
  disabled: { label: "Aus", tone: "neutral" },
};

function McpBody() {
  const runtime = useRuntimeInfo();
  if (runtime.isLoading) return <Loading />;
  const servers = runtime.data?.mcpServers ?? [];
  if (!servers.length) return <div className="text-body text-muted">Keine MCP-Server gemeldet. Die Liste füllt sich, sobald eine Session gestartet ist.</div>;
  return (
    <ul className="divide-y divide-border">
      {servers.map((s) => {
        const st = MCP_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const };
        return (
          <li key={s.name} className="flex items-center justify-between gap-3 py-2 text-body">
            <span className="min-w-0 truncate font-mono text-small">{s.name}</span>
            <Badge tone={st.tone}>{st.label}</Badge>
          </li>
        );
      })}
    </ul>
  );
}
