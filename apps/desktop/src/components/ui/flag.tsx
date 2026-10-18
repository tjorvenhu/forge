import { useId } from "react";
import type { Language } from "@forge/protocol";
import { cn } from "@/lib/utils";

/**
 * Flag for a language (no emoji: Windows draws flag emoji as two letters). The colours are those of
 * the flags, not of the theme, so they are literals here.
 */
export function Flag({ language, className }: { language: Language; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex h-3.5 w-5 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-black/25", className)}>
      {language === "de" ? <GermanFlag /> : <BritishFlag />}
    </span>
  );
}

function GermanFlag() {
  return (
    <svg viewBox="0 0 5 3" preserveAspectRatio="none" className="h-full w-full">
      <rect width="5" height="1" y="0" fill="#000000" />
      <rect width="5" height="1" y="1" fill="#DD0000" />
      <rect width="5" height="1" y="2" fill="#FFCE00" />
    </svg>
  );
}

function BritishFlag() {
  const id = useId();
  return (
    <svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
      <clipPath id={`${id}t`}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#${id}t)`} stroke="#C8102E" strokeWidth="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}
