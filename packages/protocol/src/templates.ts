/**
 * Prompt templates: placeholders like {datei} or {thema} in the text, filled in before sending, and the
 * matching that suggests a template while the user types. Pure functions, shared by the desktop UI and
 * the phone in the sidecar.
 */

/** Letters, digits, _ and -, no spaces: code like `{ a: 1 }` or JSON is no placeholder. */
const PLACEHOLDER = /\{([\p{L}\p{N}_-]{1,40})\}/gu;

/** Names of the placeholders in a template text, each once, in the order they first appear. */
export function templatePlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** The text with the placeholders replaced (names case-insensitive); unknown or empty ones stay as they are. */
export function fillTemplate(text: string, values: Record<string, string>): string {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = lower.get(name.toLowerCase());
    return v !== undefined && v.trim() !== "" ? v : whole;
  });
}

/**
 * Placeholders FORGE fills in itself where it knows the value; the form still shows them, editable.
 * Keys are lower case; aliases point to the same value.
 */
export const KNOWN_PLACEHOLDERS: Record<string, "project" | "branch" | "file" | "date"> = {
  projekt: "project",
  project: "project",
  branch: "branch",
  datei: "file",
  file: "file",
  datum: "date",
  date: "date",
};

/** Values for the known placeholders of `text`; what FORGE does not know (null) is left out. */
export function knownTemplateValues(text: string, ctx: { project?: string | null; branch?: string | null; file?: string | null; date?: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of templatePlaceholders(text)) {
    const kind = KNOWN_PLACEHOLDERS[name.toLowerCase()];
    const v = kind ? ctx[kind] : null;
    if (v) out[name] = v;
  }
  return out;
}

export interface TemplateLike {
  id: string;
  name: string;
  text: string;
  description?: string | null;
}

/** Below this many characters (without spaces) nothing is suggested. */
export const SUGGEST_MIN_CHARS = 4;
/** The beginning of a template text only counts from here on: many messages start with the same verb. */
const TEXT_START_MIN_CHARS = 10;
/** Longer input is a message of its own, not the start of a template. */
export const SUGGEST_MAX_CHARS = 240;
/** Only good matches are suggested (scores from 0 to 1). */
export const SUGGEST_MIN_SCORE = 0.7;
export const SUGGEST_MAX = 3;

/** Lower case, without accents and punctuation, single spaces; ß counts as ss. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const wordsOf = (s: string) => (s ? s.split(" ") : []);

/** Edit distance of two short words; two swapped letters count as one typo. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j]!, before[j - 2]! + 1);
    }
    before = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Whether a typed word stands for a word of the template: the same word, its beginning (the last word
 * is still being typed; others from four letters on), or from five letters on one typo.
 */
function wordMatches(typed: string, word: string, last: boolean): boolean {
  if (typed === word) return true;
  if (word.startsWith(typed) && (last ? typed.length >= 2 : typed.length >= 4)) return true;
  if (typed.length >= 5) return distance(typed, word.slice(0, typed.length), 1) <= 1 || distance(typed, word, 1) <= 1;
  return false;
}

/** Short words (der, die, für …) say little about what is meant and count less. */
const weight = (w: string) => (w.length <= 3 ? 0.3 : 1);

/**
 * How well the typed text fits a template, from 0 to 1. A template name that starts with the input
 * fits fully, the beginning of its text from a few words on; otherwise the typed words must turn up in the name or near the start of the text
 * (also as beginnings or with a typo). With a single meaningful word only the name counts: a common
 * word somewhere in the text is no reason to suggest anything.
 */
export function templateScore(input: string, t: TemplateLike): number {
  if (input.length > SUGGEST_MAX_CHARS) return 0;
  const q = normalizeForMatch(input);
  if (q.replace(/ /g, "").length < SUGGEST_MIN_CHARS) return 0;
  const name = normalizeForMatch(t.name);
  const body = normalizeForMatch(t.text);
  // The template itself is in the field already.
  if (q === body) return 0;
  if (name.startsWith(q) || (body.startsWith(q) && q.length >= TEXT_START_MIN_CHARS && q.includes(" "))) return 1;
  const typed = wordsOf(q);
  const nameWords = wordsOf(name);
  const meaningful = typed.filter((w) => w.length >= 4);
  if (meaningful.length < 2) {
    if (!meaningful.length) return 0;
    const hit = typed.every((w, i) => weight(w) < 1 || nameWords.some((n) => wordMatches(w, n, i === typed.length - 1)));
    return hit ? 0.8 : 0;
  }
  const pool = [...new Set([...nameWords, ...wordsOf(body).slice(0, 40)])];
  let total = 0;
  let found = 0;
  typed.forEach((w, i) => {
    total += weight(w);
    if (pool.some((p) => wordMatches(w, p, i === typed.length - 1))) found += weight(w);
  });
  return (found / total) * 0.9;
}

/** Templates worth suggesting for the typed text, best first (ties keep the given order). */
export function suggestTemplates<T extends TemplateLike>(input: string, templates: readonly T[], max = SUGGEST_MAX): T[] {
  return templates
    .map((t, i) => ({ t, i, score: templateScore(input, t) }))
    .filter((x) => x.score >= SUGGEST_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.t);
}

/**
 * Templates for an explicit query (the "#" prefix in the composer, the phone): every template when it
 * is empty, else those whose name, description or text contains all words, name hits first.
 */
export function findTemplates<T extends TemplateLike>(query: string, templates: readonly T[]): T[] {
  const q = wordsOf(normalizeForMatch(query));
  if (!q.length) return [...templates];
  const rank = (t: T) => {
    const name = normalizeForMatch(t.name);
    if (q.every((w) => name.includes(w))) return name.startsWith(q.join(" ")) ? 0 : 1;
    const rest = normalizeForMatch(`${t.description ?? ""} ${t.text}`);
    return q.every((w) => name.includes(w) || rest.includes(w)) ? 2 : -1;
  };
  return templates
    .map((t, i) => ({ t, i, r: rank(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}
