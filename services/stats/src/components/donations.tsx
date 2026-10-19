"use client";

import { useId, useRef } from "react";
import { ExternalLink, Heart, Lightbulb, X } from "lucide-react";
import { DONATE_URL, FEEDBACK_URL } from "@/lib/constants";
import type { Donations } from "@/lib/donations";
import { useI18n } from "./locale";
import { AnimatedNumber } from "./motion";

/**
 * "Unterstützen" with the heart in the top bar: opens the dialog of the app's heart (SupportDialog) with what was
 * given so far above the payment link. A real link, so it still leads to Stripe without JavaScript.
 */
export function SupportButton({ donations }: { donations: Donations | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t, f } = useI18n();
  const m = t.support;
  const close = () => dialog.current?.close();
  return (
    <>
      <a
        className="support-link"
        href={DONATE_URL}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          dialog.current?.showModal();
        }}
      >
        <Heart aria-hidden />
        <span className="nav-label">{m.button}</span>
      </a>
      <dialog
        ref={dialog}
        className="modal"
        aria-labelledby={titleId}
        // A click on the backdrop lands on the dialog itself, not on its content.
        onClick={(e) => e.target === e.currentTarget && close()}
      >
        <div className="modal-body">
          <header className="modal-head">
            <h2 id={titleId}>{m.title}</h2>
            <button type="button" className="modal-close" onClick={close} aria-label={m.close}>
              <X aria-hidden />
            </button>
          </header>
          <p className="modal-text">{m.text}</p>

          {donations && (
            <div className="donated">
              <span className="donated-label">{m.donated}</span>
              <span className="donated-value">
                <AnimatedNumber value={donations.cents} format={f.eur} duration={900} />
              </span>
              <span className="donated-sub">{m.contributions(donations.count, f.count(donations.count))}</span>
            </div>
          )}

          <p className="modal-note">{m.note}</p>
          <a className="btn btn-primary modal-action" href={DONATE_URL}>
            <Heart aria-hidden />
            {m.pay}
          </a>
          <a className="btn btn-outline modal-action" href={FEEDBACK_URL} title={m.feedbackTitle}>
            <Lightbulb aria-hidden />
            {m.feedback}
            <ExternalLink className="modal-external" aria-hidden />
          </a>
        </div>
      </dialog>
    </>
  );
}
