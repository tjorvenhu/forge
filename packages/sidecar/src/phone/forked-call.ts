import { EventEmitter } from "node:events";
import { tr } from "../i18n/index.js";
import type { CallEvents, PhoneCall, SipCall } from "./sip-ua.js";

/**
 * Rings several numbers at once and looks like one call to the rest of FORGE: the first leg that
 * answers takes the call, every other leg is cancelled right away (or hung up, should it have
 * answered in the same moment). Before the answer it counts as ringing as long as one leg rings.
 */
export class ForkedCall extends EventEmitter<CallEvents> implements PhoneCall {
  readonly direction = "out" as const;
  onOffer: ((sdp: string) => string | null) | null = null;
  private winner: SipCall | null = null;
  private done = false;
  private rang = false;
  private readonly endings = new Map<SipCall, string>();

  constructor(private readonly legs: SipCall[]) {
    super();
    for (const leg of legs) {
      leg.onOffer = (sdp) => (leg === this.winner ? (this.onOffer?.(sdp) ?? null) : null);
      leg.on("ringing", () => {
        if (this.winner || this.rang) return;
        this.rang = true;
        this.emit("ringing");
      });
      leg.on("answered", (body) => this.answered(leg, body));
      leg.on("dtmf", (digit) => {
        if (leg === this.winner) this.emit("dtmf", digit);
      });
      leg.on("ended", (why) => this.legEnded(leg, why));
    }
  }

  /** The number that answered; before that all numbers that ring. */
  get remoteNumber(): string {
    return this.winner?.remoteNumber ?? this.legs.map((l) => l.remoteNumber).join(", ");
  }

  get state(): "ringing" | "active" | "ended" {
    if (this.done) return "ended";
    return this.winner?.state ?? "ringing";
  }

  async hangup(reason = "Aufgelegt") {
    if (this.done) return;
    if (this.winner) return this.winner.hangup(reason);
    await Promise.all(this.legs.map((l) => l.hangup(reason)));
  }

  private answered(leg: SipCall, body: string) {
    if (this.done || (this.winner && this.winner !== leg)) {
      void leg.hangup(tr().phone.call.answeredElsewhere);
      return;
    }
    this.winner = leg;
    for (const other of this.legs) if (other !== leg) void other.hangup(tr().phone.call.answeredElsewhere);
    this.emit("answered", body);
  }

  private legEnded(leg: SipCall, why: string) {
    this.endings.set(leg, why);
    if (this.done) return;
    if (this.winner) {
      if (leg === this.winner) this.finish(why);
      return;
    }
    if (this.legs.some((l) => l.state !== "ended")) return;
    // Nobody answered: say per number why, unless every leg ended for the same reason.
    const reasons = [...new Set(this.legs.map((l) => this.endings.get(l) ?? ""))];
    this.finish(reasons.length === 1 ? reasons[0]! : this.legs.map((l) => `${l.remoteNumber}: ${this.endings.get(l) ?? "beendet"}`).join("; "));
  }

  private finish(why: string) {
    this.done = true;
    this.emit("ended", why);
  }
}
