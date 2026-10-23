"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { AlertTriangle, Bot, CheckCircle2, Hand, RotateCcw, Wrench, X } from "lucide-react";
import type { WatchView } from "@/lib/crew-web/client";
import { crewMessages, type CrewMessages } from "@/lib/crew-web/messages";
import { useI18n } from "../locale";

type Ev = Record<string, unknown> & { type?: unknown };

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** One line for a tool call: what it works on (file, command, search). */
function toolSummary(input: unknown): string {
  if (typeof input !== "object" || !input) return "";
  const i = input as Record<string, unknown>;
  const v = s(i.description) ?? s(i.file_path) ?? s(i.notebook_path) ?? s(i.command) ?? s(i.pattern) ?? s(i.url) ?? s(i.query) ?? s(i.prompt) ?? s(i.path) ?? "";
  return v.length > 160 ? `${v.slice(0, 159)}…` : v;
}

function EventRow({ e, m }: { e: Ev; m: CrewMessages }) {
  switch (e.type) {
    case "user.message":
      return s(e.text) ? <div className="crew-ev-user crew-text">{e.text as string}</div> : null;
    case "assistant.text":
      if (!s(e.text)) return null;
      return e.parentToolUseId ? (
        <div className="crew-ev-sub crew-text">
          <span className="crew-chip">
            <Bot aria-hidden /> {m.event.subagent}
          </span>
          {e.text as string}
        </div>
      ) : (
        <div className="crew-ev-text crew-text">{e.text as string}</div>
      );
    case "tool.use":
      return (
        <div className={e.parentToolUseId ? "crew-ev-tool crew-ev-tool-sub" : "crew-ev-tool"}>
          <Wrench aria-hidden />
          <strong>{String(e.name ?? "")}</strong>
          <span className="crew-ellipsis">{toolSummary(e.input)}</span>
        </div>
      );
    case "tool.result":
      return e.isError ? (
        <div className="crew-ev-tool crew-ev-error">
          <AlertTriangle aria-hidden /> {m.event.toolError}
        </div>
      ) : null;
    case "approval.request":
      return (
        <div className="crew-ev-approval">
          <Hand aria-hidden /> {m.event.approval(String(e.title ?? e.toolName ?? ""))}
        </div>
      );
    case "approval.resolved":
      return <div className="crew-ev-divider">{e.decision === "allow" ? m.event.allowed : m.event.denied}</div>;
    case "turn.result": {
      if (e.interrupted) return <div className="crew-ev-divider">{m.event.interrupted}</div>;
      if (e.isError) return <div className="crew-ev-divider crew-ev-error">{m.event.turnError}</div>;
      const ms = typeof e.durationMs === "number" ? e.durationMs : null;
      return (
        <div className="crew-ev-divider">
          <CheckCircle2 aria-hidden /> {ms === null ? m.event.turnDone("") : m.event.turnDone(ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)}
        </div>
      );
    }
    case "context.compacted":
      return <div className="crew-ev-divider">{m.event.compacted}</div>;
    case "notify":
      return s(e.message) ? <div className="crew-ev-approval">{e.message as string}</div> : null;
    case "error":
      return s(e.message) ? (
        <div className="crew-ev-tool crew-ev-error">
          <AlertTriangle aria-hidden /> {e.message as string}
        </div>
      ) : null;
    default:
      return null;
  }
}

/** A member's session, read-only and live, over the board (full screen on a phone). */
export function WatchPanel({ watch, memberName, onClose, onRetry }: { watch: WatchView; memberName: string; onClose: () => void; onRetry: () => void }) {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const events = watch.events as Ev[];
  const shown = events.filter((e) => e && typeof e === "object" && ["user.message", "assistant.text", "tool.use", "tool.result", "approval.request", "approval.resolved", "turn.result", "context.compacted", "notify", "error"].includes(String(e.type)));
  const loading = watch.state === "asking" || watch.state === "transferring";
  const over = watch.state === "failed" || watch.state === "ended" || watch.state === "declined";
  const error = watch.error ? ((m.watchErrors as Record<string, string>)[watch.error] ?? watch.error) : null;

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, watch.state]);

  return (
    <div className="crew-watch" role="dialog" aria-modal="true" aria-label={m.watchTitle(memberName, watch.title)}>
      <div className="crew-watch-panel">
        <header>
          <div className="crew-watch-title">
            <strong className="crew-ellipsis">{m.watchTitle(memberName, watch.title)}</strong>
            <span className={watch.state === "live" ? "live-badge live-badge-on" : "live-badge"}>
              {watch.state === "live" && <span className="live-dot live-dot-on" aria-hidden />}
              {m.watchState[watch.state]}
              {watch.state === "transferring" && watch.total ? ` · ${m.watchProgress(watch.received, watch.total)}` : ""}
            </span>
          </div>
          {over && (
            <button type="button" className="btn btn-outline crew-small" onClick={onRetry}>
              <RotateCcw aria-hidden /> {m.watchRetry}
            </button>
          )}
          <button type="button" className="crew-icon-btn" onClick={onClose} aria-label={m.close} title={m.close}>
            <X aria-hidden />
          </button>
        </header>
        <div
          className="crew-watch-body"
          ref={body}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          aria-live="polite"
          aria-busy={loading}
        >
          {error && (
            <div className="error-banner" role="alert">
              <X aria-hidden />
              <p>{error}</p>
            </div>
          )}
          {loading && (
            <div className="crew-watch-skeleton" aria-label={m.watchState[watch.state]}>
              <span className="skeleton-bar crew-sk-user" />
              <span className="skeleton-bar crew-sk-line" />
              <span className="skeleton-bar crew-sk-line crew-sk-short" />
              <span className="skeleton-bar crew-sk-tool" />
              <span className="skeleton-bar crew-sk-tool" />
              <span className="skeleton-bar crew-sk-line" />
            </div>
          )}
          {!loading && !error && !shown.length && <p className="crew-empty">{m.watchEmpty}</p>}
          {shown.map((e, i) => (
            <EventRow key={i} e={e} m={m} />
          ))}
        </div>
      </div>
    </div>
  );
}
