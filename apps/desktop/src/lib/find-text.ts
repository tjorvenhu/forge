/**
 * Matching for the search in the chat (Ctrl+F), the same way the sidecar's full-text index matches: plain
 * words, each one as the start of a word, case and accents ignored. The sidecar finds the messages; this
 * marks the words in the text that is on screen.
 */

/** Words of a query like the sidecar reads them (at most 8), folded. */
export function findWords(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 8).map((w) => fold(w).text);
}

/**
 * Lower case without accents (ä → a, É → e), with the offset in the original text of every folded
 * character: folding can change the length (a combining mark disappears, İ becomes two characters).
 */
export function fold(text: string): { text: string; starts: number[]; ends: number[] } {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    out += f;
    i += ch.length;
  }
  return { text: out, starts, ends };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for folded text: every word at the start of a word, or with `phrase` the words in a row. */
export function findPattern(words: string[], phrase: boolean): RegExp | null {
  if (!words.length) return null;
  const start = "(?<![\\p{L}\\p{N}_])";
  const body = phrase ? start + words.map(escape).join("[^\\p{L}\\p{N}_]+") : `${start}(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join("|")})`;
  return new RegExp(body, "gu");
}

/** Ranges [start, end) in `text` that match, in order and without overlap. */
export function findMatches(text: string, pattern: RegExp | null): Array<[number, number]> {
  if (!pattern || !text) return [];
  const f = fold(text);
  const out: Array<[number, number]> = [];
  pattern.lastIndex = 0;
  for (const m of f.text.matchAll(pattern)) {
    if (!m[0]) continue;
    const start = f.starts[m.index]!;
    const end = f.ends[m.index + m[0].length - 1]!;
    const last = out[out.length - 1];
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
