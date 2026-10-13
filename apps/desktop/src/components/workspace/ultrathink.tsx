import type { ReactNode } from "react";

/** Claude Code thinks with the highest budget for a prompt that contains this word, wherever it stands. */
const KEYWORD = /\bultrathink\b/i;
const SPLIT = /(\bultrathink\b)/gi;

export function hasUltrathink(text: string): boolean {
  return KEYWORD.test(text);
}

/** The text with the keyword in rainbow colors, like Claude Code's input line shows it. */
export function withUltrathink(text: string): ReactNode {
  if (!hasUltrathink(text)) return text;
  return text.split(SPLIT).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="ultrathink-text">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
