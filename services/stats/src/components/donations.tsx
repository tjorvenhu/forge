"use client";

import { useRef } from "react";
import { ExternalLink, Heart, Lightbulb, X } from "lucide-react";
import { DONATE_URL, FEEDBACK_URL } from "@/lib/constants";
import type { Donations } from "@/lib/donations";
import { formatCount, formatEur } from "@/lib/format";
import { AnimatedNumber } from "./motion";

/**
 * "Unterstützen" in the top bar: opens the dialog of the app's heart (SupportDialog) with what was
 * given so far above the payment link. A real link, so it still leads to Stripe without JavaScript.
 */
export function SupportButton({ donations }: { donations: Donations | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => dialog.current?.close();
  return (
    <>
      <a
        className="btn btn-primary"
        href={DONATE_URL}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          dialog.current?.showModal();
        }}
      >
        <Heart aria-hidden />
        Unterstützen
      </a>
      <dialog
        ref={dialog}
        className="modal"
        aria-labelledby="support-title"
        // A click on the backdrop lands on the dialog itself, not on its content.
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div className="modal-body">
          <header className="modal-head">
            <h2 id="support-title">FORGE unterstützen</h2>
            <button type="button" className="modal-close" onClick={close} aria-label="Schließen">
              <X aria-hidden />
            </button>
          </header>
          <p className="modal-text">
            FORGE ist ein Open-Source-Produkt der Vanturis UG. Wenn es dir hilft, kannst du die Weiterentwicklung mit einem freiwilligen Beitrag unterstützen oder Verbesserungen vorschlagen.
          </p>

          {donations && (
            <div className="donated">
              <span className="donated-label">Bisher gespendet</span>
              <span className="donated-value">
                <AnimatedNumber value={donations.cents} format={formatEur} duration={900} />
              </span>
              <span className="donated-sub">
                {formatCount(donations.count)} {donations.count === 1 ? "Beitrag" : "Beiträge"}, vor Gebühren
              </span>
            </div>
          )}

          <p className="modal-note">Den Betrag wählst du selbst. Das Geld geht an die Vanturis UG, die FORGE entwickelt. Sie ist nicht gemeinnützig, eine Spendenquittung gibt es deshalb nicht.</p>
          <a className="btn btn-primary modal-action" href={DONATE_URL}>
            <Heart aria-hidden />
            Beitrag über Stripe zahlen
          </a>
          <a className="btn btn-outline modal-action" href={FEEDBACK_URL} title="Als Issue auf GitHub, mit GitHub-Konto">
            <Lightbulb aria-hidden />
            Vorschlag oder Fehler melden
            <ExternalLink className="modal-external" aria-hidden />
          </a>
        </div>
      </dialog>
    </>
  );
}
