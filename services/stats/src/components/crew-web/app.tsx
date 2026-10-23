"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { CrewWebClient } from "@/lib/crew-web/client";
import { supported } from "@/lib/crew-web/crypto";
import { crewMessages } from "@/lib/crew-web/messages";
import { decodeInvite } from "@/lib/crew-web/wire";
import { useI18n } from "../locale";
import { CrewBoard } from "./crew-view";
import { ClosedCard, JoinForm, PendingCard } from "./join";
import { useCrew } from "./util";

/**
 * The crew in the browser: the crews of this browser (localStorage), joining with an invite from the
 * link's #, and the board of the chosen crew. Everything runs here; the server only relays sealed bytes.
 */
export function CrewApp() {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  const [clients, setClients] = useState<CrewWebClient[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const live = useRef<CrewWebClient[]>([]);

  useEffect(() => {
    const list = CrewWebClient.list();
    live.current = list;
    for (const c of list) c.start();
    // The invite in the link (…/crew#forge-crew1.…) is read once and taken out of the address bar.
    let fromHash = window.location.hash.slice(1);
    try {
      fromHash = decodeURIComponent(fromHash);
    } catch {
      // Not percent-encoded: taken as it is.
    }
    const invite = decodeInvite(fromHash);
    if (invite) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      const known = list.find((c) => c.roomId === invite.r && c.view().membership !== "rejected" && c.view().membership !== "removed");
      if (known) setActive(known.id);
      else {
        setCode(fromHash);
        setAdding(true);
      }
    }
    setActive((cur) => cur ?? list[0]?.id ?? null);
    setClients(list);
    void supported().then(setOk);
    const wake = () => {
      if (document.visibilityState === "visible") for (const c of live.current) c.wake();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      for (const c of live.current) c.stop();
    };
  }, []);

  const joined = useCallback((c: CrewWebClient) => {
    c.start();
    live.current = [...live.current.filter((x) => x.id !== c.id), c];
    setClients(live.current);
    setActive(c.id);
    setAdding(false);
    setCode("");
  }, []);

  const gone = useCallback((id: string) => {
    live.current = live.current.filter((x) => x.id !== id);
    setClients(live.current);
    setActive(live.current[0]?.id ?? null);
  }, []);

  if (clients === null) return <BoardSkeleton label={m.loading} />;

  if (ok === false) {
    return (
      <div className="crew-card crew-pending">
        <AlertTriangle aria-hidden className="crew-warn-icon" />
        <p>{m.unsupported}</p>
      </div>
    );
  }

  const current = clients.find((c) => c.id === active) ?? null;
  const showJoin = adding || !current;

  return (
    <div className="crew-app">
      {(clients.length > 1 || (clients.length > 0 && !showJoin)) && (
        <nav className="crew-switch" aria-label={m.crews}>
          {clients.map((c) => (
            <CrewChip key={c.id} client={c} on={!showJoin && c.id === current?.id} onClick={() => (setActive(c.id), setAdding(false))} />
          ))}
          {!showJoin && (
            <button type="button" className="crew-chip-btn" onClick={() => setAdding(true)}>
              <Plus aria-hidden /> {m.addCrew}
            </button>
          )}
        </nav>
      )}
      {showJoin ? (
        <div className="crew-intro">
          {!clients.length && (
            <div className="intro">
              <h1>{m.title}</h1>
              <p>{m.lead}</p>
            </div>
          )}
          <JoinForm initialCode={code} joinedRooms={clients.filter((c) => c.view().membership !== "rejected" && c.view().membership !== "removed").map((c) => c.roomId)} onJoined={joined} onCancel={clients.length ? () => setAdding(false) : null} />
        </div>
      ) : (
        <CrewScreen key={current.id} client={current} onGone={() => gone(current.id)} />
      )}
    </div>
  );
}

function CrewChip({ client, on, onClick }: { client: CrewWebClient; on: boolean; onClick: () => void }) {
  const crew = useCrew(client);
  return (
    <button type="button" className="crew-chip-btn" aria-pressed={on} onClick={onClick}>
      <span className={crew.connection === "online" ? "live-dot live-dot-on" : "live-dot"} aria-hidden />
      {crew.name}
    </button>
  );
}

function CrewScreen({ client, onGone }: { client: CrewWebClient; onGone: () => void }) {
  const crew = useCrew(client);
  if (crew.membership === "pending")
    return (
      <PendingCard
        crew={crew}
        onCancel={() => {
          client.forget();
          onGone();
        }}
      />
    );
  if (crew.membership === "rejected" || crew.membership === "removed")
    return (
      <ClosedCard
        crew={crew}
        onForget={() => {
          client.forget();
          onGone();
        }}
      />
    );
  return <CrewBoard client={client} crew={crew} onLeft={onGone} />;
}

/** The board's shape while the crews load from this browser. */
function BoardSkeleton({ label }: { label: string }) {
  return (
    <div className="crew-board crew-skeleton" aria-busy="true" aria-label={label}>
      <div className="crew-board-head">
        <div className="crew-board-title">
          <span className="skeleton-bar crew-sk-title" />
          <span className="skeleton-bar crew-sk-sub" />
        </div>
      </div>
      <div className="crew-tabs">
        <span className="skeleton-bar crew-sk-tab" />
        <span className="skeleton-bar crew-sk-tab" />
        <span className="skeleton-bar crew-sk-tab" />
      </div>
      <div className="crew-columns">
        <div className="crew-col crew-col-chat">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="crew-feed-item">
              <span className="skeleton-bar crew-avatar" />
              <div className="crew-feed-body">
                <span className="skeleton-bar crew-sk-sub" />
                <span className="skeleton-bar crew-sk-line" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
