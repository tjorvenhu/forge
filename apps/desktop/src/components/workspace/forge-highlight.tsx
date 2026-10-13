import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Colour of a FORGE card: orange for what FORGE did, yellow and red when it was refused or failed. */
export type ForgeTone = "accent" | "warning" | "danger";

export const FORGE_ICON_TONE: Record<ForgeTone, string> = { accent: "text-accent", warning: "text-warning", danger: "text-danger" };

const CARD_TONE: Record<ForgeTone, string> = {
  accent: "border-accent/30 bg-accent-soft",
  warning: "border-warning/40 bg-warning-soft",
  danger: "border-danger/40 bg-danger-soft",
};

/**
 * The highlighted box of everything FORGE itself does in the chat: knowledge saved, agent started,
 * auto-commit, notification. Rows using it put their gutter icon 9px lower (`FORGE_MARKER_OFFSET`),
 * level with the first text line inside the padding and border.
 */
export function ForgeHighlight({ tone, children }: { tone: ForgeTone; children: ReactNode }) {
  return <div className={cn("rounded-md border px-3 py-2", CARD_TONE[tone])}>{children}</div>;
}

export const FORGE_MARKER_OFFSET = "mt-2.25";

export function ForgeLabel() {
  return <span className="shrink-0 text-caption font-medium uppercase tracking-wide text-subtle">FORGE</span>;
}
