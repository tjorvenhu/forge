"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";
import type { MemberView, WatchView } from "@/lib/crew-web/client";
import { crewMessages } from "@/lib/crew-web/messages";
import { useI18n } from "../locale";
import { MemberAvatar } from "./avatar";
import { SessionChat } from "./session-chat";

/** A member's session, read-only and live, over the board (full screen on a phone), drawn like FORGE's chat. */
export function WatchPanel({ watch, member, onClose, onRetry }: { watch: WatchView; member: MemberView | null; onClose: () => void; onRetry: () => void }) {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loading = watch.state === "asking" || watch.state === "transferring";
  const over = watch.state === "failed" || watch.state === "ended" || watch.state === "declined";
  const error = watch.error ? ((m.watchErrors as Record<string, string>)[watch.error] ?? watch.error) : null;
  const name = member?.name ?? "?";
  const agent = member?.agents.find((a) => a.id === watch.agentId) ?? null;
  const working = watch.state === "live" && agent && agent.status !== "idle" ? agent.status : null;

  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [watch.events.length, watch.state, working]);

  return (
    <div className="crew-watch" role="dialog" aria-modal="true" aria-label={m.watchTitle(name, watch.title)}>
      <div className="crew-watch-panel">
        <header>
          <MemberAvatar name={name} color={member?.color ?? "var(--color-subtle)"} avatar={member?.avatar} size={26} />
          <div className="crew-watch-title">
            <strong className="crew-ellipsis">{watch.title}</strong>
            <span className="crew-watch-sub">
              <span className="crew-ellipsis">{name}</span>
              {watch.model && <span className="crew-watch-model">{watch.model}</span>}
            </span>
          </div>
          <span className={watch.state === "live" ? "live-badge live-badge-on" : "live-badge"}>
            {watch.state === "live" && <span className="live-dot live-dot-on" aria-hidden />}
            {m.watchState[watch.state]}
            {watch.state === "transferring" && watch.total ? ` · ${m.watchProgress(watch.received, watch.total)}` : ""}
          </span>
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
          {loading && <ChatSkeleton label={m.watchState[watch.state]} />}
          {!loading && !error && !watch.events.length && <p className="crew-empty">{m.watchEmpty}</p>}
          {!loading && (
            <SessionChat
              events={watch.events}
              m={m.chat}
              live={watch.state === "live"}
              working={working}
              cwd={watch.cwd}
              member={{ name, color: member?.color ?? "var(--color-subtle)", avatar: member?.avatar ?? null }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The shape of a chat while the copy arrives: a prompt, Claude's answer, tool lines. */
function ChatSkeleton({ label }: { label: string }) {
  return (
    <div className="fc-thread" aria-label={label}>
      {[
        ["avatar", "sk-text sk-w60"],
        ["claude", "sk-text sk-w85", "sk-text sk-w70"],
        ["dot", "sk-tool sk-w45"],
        ["dot", "sk-tool sk-w55"],
        ["dot", "sk-text sk-w80", "sk-text sk-w40"],
      ].map(([marker, ...lines], i) => (
        <div key={i} className={`fc-row fc-gap-${i === 0 ? "first" : i === 1 ? "block" : "tight"}`}>
          <div className="fc-chatrow">
            <span className="fc-gutter">
              <span className={`skeleton-bar ${marker === "dot" ? "sk-dot" : "sk-avatar"}`} />
            </span>
            <div className="fc-content fc-sk-lines">
              {lines.map((l, j) => (
                <span key={j} className={`skeleton-bar ${l}`} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
