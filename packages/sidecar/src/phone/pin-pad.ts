import type { PinResult } from "./pin-guard.js";

const MAX_PIN_TRIES = 3;

export interface PinPadHost {
  /** null when steering needs no PIN; "locked" when PIN entry is blocked after too many failures */
  checkPin: ((pin: string) => Promise<PinResult>) | null;
  /** false while FORGE says goodbye or after the call ended: digits are ignored, late results dropped */
  accepting(): boolean;
  onUnlocked(): void;
  /** entry blocked after too many failures (across calls) */
  onLocked(): void;
  /** wrong PIN; `final` when this call has used up its tries */
  onWrong(final: boolean): void;
  log(message: string): void;
}

/**
 * PIN entry over the keypad: digits, `*` clears, `#` checks. This never goes through the language
 * model, so nothing the model reads or hears can unlock steering on its own.
 */
export class PinPad {
  unlocked = false;
  private pin = "";
  private tries = 0;
  /** no more attempts in this call: limit reached or locked */
  private closed = false;
  private checking = false;

  constructor(private readonly h: PinPadHost) {}

  digit(digit: string) {
    if (!this.h.checkPin || this.unlocked || this.closed || this.checking || !this.h.accepting()) return;
    if (digit === "*") {
      this.pin = "";
      return;
    }
    if (digit !== "#") {
      if (this.pin.length < 16) this.pin += digit;
      return;
    }
    const entered = this.pin;
    this.pin = "";
    this.checking = true;
    void this.h
      .checkPin(entered)
      .catch((e: unknown) => {
        this.h.log(`PIN-Prüfung: ${e instanceof Error ? e.message : String(e)}`);
        return "wrong" as const;
      })
      .then((result) => {
        this.checking = false;
        this.onResult(result);
      });
  }

  private onResult(result: PinResult) {
    // A goodbye may have started while the PIN was checked; a late correct PIN must not unlock it.
    if (!this.h.accepting() || this.closed) return;
    if (result === "ok") {
      this.unlocked = true;
      this.h.onUnlocked();
      return;
    }
    if (result === "locked") {
      this.closed = true;
      this.h.log("PIN-Eingabe gesperrt (zu viele Fehlversuche)");
      this.h.onLocked();
      return;
    }
    const final = ++this.tries >= MAX_PIN_TRIES;
    if (final) {
      this.closed = true;
      this.h.log("PIN dreimal falsch, Anruf beendet");
    }
    this.h.onWrong(final);
  }
}

export const PIN_TEXT = {
  unlockedNote: "[FORGE: PIN richtig, Steuern ist frei. Sag nur „Freigeschaltet.“ Wollte der Anrufer vorher schon etwas Gesperrtes, erledige es jetzt.]",
  locked: "Die PIN-Eingabe ist nach zu vielen Fehlversuchen vorübergehend gesperrt. Steuern geht in diesem Gespräch nicht.",
  wrong: "Die PIN ist falsch. Bitte noch einmal eingeben und mit Raute bestätigen.",
  final: "Die PIN war mehrmals falsch. Ich lege auf.",
};
