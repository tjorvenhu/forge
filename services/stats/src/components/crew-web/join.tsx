"use client";

import { useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Lock, LogIn, ShieldCheck, X } from "lucide-react";
import { CREW_COLORS, CrewWebClient, type CrewView } from "@/lib/crew-web/client";
import { crewMessages } from "@/lib/crew-web/messages";
import { decodeInvite } from "@/lib/crew-web/wire";
import { useI18n } from "../locale";
import { errorText } from "./util";

const PROFILE_KEY = "forge.crew.web-profile";

function storedProfile(): { name: string; color: string } {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "null") as { name?: unknown; color?: unknown } | null;
    if (p && typeof p.name === "string" && typeof p.color === "string") return { name: p.name, color: p.color };
  } catch {
    // Nothing stored or blocked storage: a fresh profile.
  }
  return { name: "", color: CREW_COLORS[Math.floor(Math.random() * CREW_COLORS.length)]! };
}

/** Asks to join with an invite code or the link FORGE shows (and the QR code holds). */
export function JoinForm({ initialCode, joinedRooms, onJoined, onCancel }: { initialCode: string; joinedRooms: string[]; onJoined: (c: CrewWebClient) => void; onCancel: (() => void) | null }) {
  const { locale, f } = useI18n();
  const m = crewMessages(locale);
  const [code, setCode] = useState(initialCode);
  const [profile, setProfile] = useState(storedProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invite = useMemo(() => decodeInvite(code), [code]);
  const expired = !!invite && invite.x * 1000 < Date.now();
  const joined = !!invite && joinedRooms.includes(invite.r);
  const codeProblem = code.trim() && !invite ? m.codeInvalid : expired ? m.codeExpired : joined ? m.alreadyJoined : null;
  const canJoin = !!invite && !expired && !joined && profile.name.trim().length > 0 && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canJoin) return;
    setBusy(true);
    setError(null);
    try {
      const p = { name: profile.name.trim().slice(0, 60), color: profile.color };
      try {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
      } catch {
        // Not stored: asked again next time.
      }
      onJoined(await CrewWebClient.join(code, p));
    } catch (err) {
      setError(errorText(err, m));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="crew-card crew-join" onSubmit={(e) => void submit(e)}>
      <div className="crew-card-head">
        {onCancel && (
          <button type="button" className="crew-icon-btn" onClick={onCancel} aria-label={m.back} title={m.back}>
            <ArrowLeft aria-hidden />
          </button>
        )}
        <h2>{m.joinTitle}</h2>
      </div>
      <label className="crew-field">
        <span>{m.codeLabel}</span>
        <textarea value={code} onChange={(e) => setCode(e.target.value)} placeholder={m.codePlaceholder} rows={3} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        {codeProblem ? <small className="crew-field-error">{codeProblem}</small> : <small>{m.codeHint}</small>}
      </label>
      {invite && !codeProblem && (
        <div className="crew-invite-preview">
          <ShieldCheck aria-hidden />
          <div>
            <strong>{m.invitePreview(invite.n, invite.p, invite.f)}</strong>
            <span>{m.inviteUntil(f.dateTime(new Date(invite.x * 1000).toISOString()))}</span>
          </div>
        </div>
      )}
      <label className="crew-field">
        <span>{m.nameLabel}</span>
        <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder={m.namePlaceholder} maxLength={60} autoComplete="nickname" />
      </label>
      <fieldset className="crew-field crew-colors">
        <legend>{m.colorLabel}</legend>
        <div>
          {CREW_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              className="crew-swatch"
              style={{ background: c }}
              aria-pressed={profile.color === c}
              aria-label={m.colorName(i + 1)}
              title={m.colorName(i + 1)}
              onClick={() => setProfile({ ...profile, color: c })}
            />
          ))}
        </div>
      </fieldset>
      {error && (
        <div className="error-banner" role="alert">
          <X aria-hidden />
          <div>
            <p className="error-title">{m.joinFailed}</p>
            <p>{error}</p>
          </div>
        </div>
      )}
      <button type="submit" className="btn btn-primary crew-wide" disabled={!canJoin} aria-busy={busy}>
        <LogIn aria-hidden /> {m.join}
      </button>
      <p className="crew-note">
        <Lock aria-hidden /> {m.security}
      </p>
    </form>
  );
}

/** Waiting for a member to let us in; both sides see the same check code. */
export function PendingCard({ crew, onCancel }: { crew: CrewView; onCancel: () => void }) {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  return (
    <div className="crew-card crew-pending" aria-live="polite">
      <span className={crew.connection === "online" ? "live-dot live-dot-on" : "live-dot"} aria-hidden />
      <h2>{m.pendingTitle}</h2>
      <p className="crew-muted">{crew.name} · {m.project(crew.project)}</p>
      <p>{m.pendingText}</p>
      <output className="crew-code">{crew.joinCode}</output>
      <button type="button" className="btn btn-outline" onClick={onCancel}>
        {m.pendingCancel}
      </button>
    </div>
  );
}

/** Turned down or removed: only forgetting the crew is left. */
export function ClosedCard({ crew, onForget }: { crew: CrewView; onForget: () => void }) {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  const removed = crew.membership === "removed";
  return (
    <div className="crew-card crew-pending">
      <h2>{removed ? m.removedTitle : m.rejectedTitle}</h2>
      <p className="crew-muted">{crew.name} · {m.project(crew.project)}</p>
      <p>{removed ? m.removedText : m.rejectedText}</p>
      <button type="button" className="btn btn-outline" onClick={onForget}>
        {m.forget}
      </button>
    </div>
  );
}
