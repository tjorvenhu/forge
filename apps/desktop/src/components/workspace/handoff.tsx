import { useState } from "react";
import { ArrowRightLeft, MessageSquarePlus, Shrink, X } from "lucide-react";
import { LONG_SESSION_CHOICES, type Session, type SessionEventBody } from "@forge/protocol";
import { call, keys, queryClient, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems } from "@/lib/context-menu";
import { formatTokens } from "@/lib/utils";
import { isBusy } from "@/lib/working";
import { cardKey, useCardState } from "@/stores/card-state";
import { draftKey, useDrafts } from "@/stores/drafts";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import type { SelectOption } from "@/components/ui/select";
import { openChat } from "./chat-slot";
import { EventCard } from "./EventCard";
import { compactSession } from "./useSendMessage";

const MENU_ICON = "h-3.5 w-3.5";

/** "Aus", "ab 100 Tsd. Tokens" … */
export function longSessionLabel(tokens: number): string {
  return tokens <= 0 ? "Aus" : `ab ${(tokens / 1000).toLocaleString("de-DE", { maximumFractionDigits: 0 })} Tsd. Tokens`;
}

/** The fixed choices, plus the current value when it was set elsewhere (the phone takes any number). */
export function longSessionOptions(current: number): SelectOption<string>[] {
  const values: number[] = [...LONG_SESSION_CHOICES];
  if (!values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).map((t) => ({ value: String(t), label: longSessionLabel(t) }));
}

/** Context tokens of a session that has grown past the threshold; null when it has not (or the hint is off). */
export function longSessionTokens(session: Pick<Session, "context"> | null | undefined, threshold: number): number | null {
  const tokens = session?.context?.totalTokens ?? 0;
  return threshold > 0 && tokens >= threshold ? tokens : null;
}

/**
 * Goes on in a new session that starts with Claude's handover of this one. A draft typed in this
 * session's composer moves along, so the next message lands in the new session.
 */
export async function handoffSession(session: Pick<Session, "id" | "projectId">, fromDraftKey?: string) {
  try {
    const next = await call("sessions.handoff", { sessionId: session.id });
    queryClient.setQueryData(keys.session(next.id), next);
    void queryClient.invalidateQueries({ queryKey: keys.sessions(session.projectId) });
    const drafts = useDrafts.getState();
    const from = fromDraftKey ?? draftKey(session.projectId, session.id);
    const draft = drafts.drafts[from];
    if (draft && (draft.text || draft.files.length)) {
      const to = draftKey(session.projectId, next.id);
      drafts.setText(to, draft.text);
      drafts.updateFiles(to, () => draft.files);
      drafts.clear(from);
    }
    openChat(session.projectId, next.id);
    toast.success("In neuer Session weiter", "Claude fasst den bisherigen Verlauf als Übergabe zusammen. Deine nächste Nachricht wartet, bis das fertig ist.");
  } catch (e) {
    toast.error("Nicht übergeben", errorMessage(e));
  }
}

/**
 * Above the composer once the context is large: every message sends the whole history again, so a
 * long session uses up the usage limit faster. Offers a new session with a handover, or /compact here.
 * Hidden, it comes back when the context has grown by another half of the threshold.
 */
export function LongSessionHint({ session, draftKey: fromDraftKey, disabled }: { session: Session; draftKey: string; disabled: boolean }) {
  const settings = useSettings().data;
  const threshold = settings?.longSessionTokens ?? 0;
  const tokens = longSessionTokens(session, threshold);
  const [hiddenAt, setHiddenAt] = useCardState<number | null>(cardKey(session.id, "long-session", "hidden"), null);
  const [busy, setBusy] = useState(false);
  if (tokens === null) return null;
  if (hiddenAt !== null && tokens < hiddenAt + threshold / 2) return null;
  const locked = disabled || busy || isBusy(session.status);
  const handoff = async () => {
    setBusy(true);
    await handoffSession(session, fromDraftKey);
    setBusy(false);
  };
  const compact = () => void compactSession(session.id);
  return (
    <div
      role="status"
      className="mb-2 flex animate-fade-in items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-2 text-small"
      onContextMenu={contextItems(() => [
        { label: "In neuer Session weitermachen", icon: <MessageSquarePlus className={MENU_ICON} />, disabled: locked, onSelect: () => void handoff() },
        { label: "Hier komprimieren", icon: <Shrink className={MENU_ICON} />, hint: "/compact", disabled: locked, onSelect: compact },
        { label: "Hinweis ausblenden", icon: <X className={MENU_ICON} />, onSelect: () => setHiddenAt(tokens) },
      ])}
    >
      <ArrowRightLeft className="h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-fg">Lange Session: {formatTokens(tokens)} Tokens Kontext.</span>{" "}
        <span className="text-muted">Jede Nachricht schickt den ganzen Verlauf mit und verbraucht mehr vom Limit. Eine neue Session übernimmt das Wissen als Zusammenfassung.</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="primary" onClick={() => void handoff()} loading={busy} disabled={locked && !busy}>
          In neuer Session weiter
        </Button>
        <Button size="sm" variant="ghost" onClick={compact} disabled={locked} title="Den Verlauf hier zusammenfassen (/compact)">
          Komprimieren
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setHiddenAt(tokens)} aria-label="Hinweis ausblenden" title="Ausblenden">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Card in both chats of a handover: links to the other session. */
export function HandoffCard({ body, ts, sessionId }: { body: Extract<SessionEventBody, { type: "session.handoff" }>; ts: string; sessionId: string }) {
  const from = body.direction === "from";
  const title = body.otherTitle ?? "Ohne Titel";
  const size = body.contextTokens ? `${formatTokens(body.contextTokens)} Tokens Kontext` : null;
  // Both sessions belong to the same project; the shown one is in the cache.
  const projectId = queryClient.getQueryData<Session>(keys.session(sessionId))?.projectId ?? useUi.getState().activeProjectId;
  const open = projectId ? () => openChat(projectId, body.otherSessionId) : undefined;
  return (
    <div onContextMenu={open ? contextItems(() => [{ label: from ? "Vorherige Session öffnen" : "Neue Session öffnen", icon: <ArrowRightLeft className={MENU_ICON} />, onSelect: open }]) : undefined}>
      <EventCard
        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
        tone="info"
        title={from ? "Fortsetzung einer langen Session" : "In neuer Session fortgesetzt"}
        refText={title}
        detail={from ? `Claude hat den Verlauf${size ? ` (${size})` : ""} als Übergabe zusammengefasst und weiß, wo es weitergeht.` : `Diese Session bleibt, wie sie ist.${size ? ` Sie hatte ${size}.` : ""}`}
        ts={ts}
        highlight
        action={
          open && (
            <Button size="sm" variant="ghost" onClick={open}>
              Öffnen
            </Button>
          )
        }
      />
    </div>
  );
}
