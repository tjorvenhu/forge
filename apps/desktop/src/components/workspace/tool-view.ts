export type DiffLine = { kind: "add" | "del" | "ctx" | "gap"; text: string };

/** Above this many cells the line diff falls back to "all removed, all added". */
const LCS_LIMIT = 250_000;
/** Unchanged lines kept around a change; longer unchanged runs collapse into a gap. */
const CONTEXT = 2;
/** Longer lines are cut in the collapsed preview, so one minified line cannot fill the screen. */
const PREVIEW_LINE_CHARS = 300;

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Tool output without the reminders Claude Code appends for the model, and without trailing blank lines. */
export function cleanToolOutput(text: string): string {
  return text.replace(REMINDER, "").replace(/\s+$/, "");
}

export function splitPreview(text: string, max: number): { lines: string[]; hidden: number; cut: boolean } {
  const all = text ? text.split(/\r?\n/) : [];
  const shown = all.slice(0, max);
  let cut = false;
  const lines = Number.isFinite(max)
    ? shown.map((l) => {
        if (l.length <= PREVIEW_LINE_CHARS) return l;
        cut = true;
        return `${l.slice(0, PREVIEW_LINE_CHARS)} …`;
      })
    : shown;
  return { lines, hidden: all.length - shown.length, cut };
}

function lcs(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split(/\r?\n/) : [];
  const b = after ? after.split(/\r?\n/) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid: DiffLine[] =
    midA.length * midB.length <= LCS_LIMIT
      ? lcs(midA, midB)
      : [...midA.map((text): DiffLine => ({ kind: "del", text })), ...midB.map((text): DiffLine => ({ kind: "add", text }))];
  const ctx = (text: string): DiffLine => ({ kind: "ctx", text });
  return [...a.slice(0, start).map(ctx), ...mid, ...a.slice(endA).map(ctx)];
}

/** Keeps a few unchanged lines around each change; the rest of an unchanged run becomes one gap. */
export function collapseContext(lines: DiffLine[], keep = CONTEXT): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "ctx") {
      out.push(lines[i++]!);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.kind === "ctx") j++;
    const run = lines.slice(i, j);
    const leading = i === 0;
    const trailing = j === lines.length;
    if (leading && trailing) out.push(...run.slice(0, keep));
    else if (leading) out.push(...run.slice(-keep));
    else if (trailing) out.push(...run.slice(0, keep));
    else if (run.length > keep * 2 + 1) out.push(...run.slice(0, keep), { kind: "gap", text: "" }, ...run.slice(-keep));
    else out.push(...run);
    i = j;
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The change an Edit, MultiEdit or Write makes, from its input; null for other tools. */
export function editDiff(name: string, input: Record<string, unknown>): DiffLine[] | null {
  switch (name) {
    case "Edit":
      return collapseContext(lineDiff(str(input.old_string), str(input.new_string)));
    case "MultiEdit": {
      if (!Array.isArray(input.edits)) return null;
      const out: DiffLine[] = [];
      for (const e of input.edits as Array<Record<string, unknown>>) {
        if (!e || typeof e !== "object") continue;
        if (out.length) out.push({ kind: "gap", text: "" });
        out.push(...collapseContext(lineDiff(str(e.old_string), str(e.new_string))));
      }
      return out;
    }
    case "Write": {
      const content = str(input.content).replace(/\r?\n$/, "");
      return content ? content.split(/\r?\n/).map((text) => ({ kind: "add", text })) : [];
    }
    default:
      return null;
  }
}

export function diffStats(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.kind === "add") add++;
    else if (l.kind === "del") del++;
  }
  return { add, del };
}

/** Number of lines a Read returned, for "(120 Zeilen)" in the tool line. */
export function countLines(text: string): number {
  const t = cleanToolOutput(text);
  return t ? t.split(/\r?\n/).length : 0;
}
