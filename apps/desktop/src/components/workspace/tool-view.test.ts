import { describe, expect, it } from "vitest";
import { cleanToolOutput, collapseContext, countLines, diffStats, editDiff, lineDiff, splitPreview, type DiffLine } from "./tool-view";

const kinds = (lines: DiffLine[]) => lines.map((l) => (l.kind === "gap" ? "gap" : `${l.kind}:${l.text}`));

describe("line diff", () => {
  it("marks only the changed lines and keeps the rest as context", () => {
    expect(kinds(lineDiff("a\nb\nc", "a\nB\nc"))).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
    expect(kinds(lineDiff("", "neu"))).toEqual(["add:neu"]);
    expect(kinds(lineDiff("x\ny", "y"))).toEqual(["del:x", "ctx:y"]);
  });

  it("finds unchanged lines between changes", () => {
    expect(kinds(lineDiff("1\n2\n3\n4", "1\nzwei\n3\nvier"))).toEqual(["ctx:1", "del:2", "add:zwei", "ctx:3", "del:4", "add:vier"]);
  });

  it("keeps two lines around a change and collapses long unchanged runs", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "g", "h", "I"].join("\n");
    expect(kinds(collapseContext(lineDiff(before, after)))).toEqual(["del:a", "add:A", "ctx:b", "ctx:c", "gap", "ctx:g", "ctx:h", "del:i", "add:I"]);
    expect(kinds(collapseContext(lineDiff("1\n2\n3\n4\nx", "1\n2\n3\n4\ny")))).toEqual(["ctx:3", "ctx:4", "del:x", "add:y"]);
  });
});

describe("edit diffs of tools", () => {
  it("builds the change of Edit, MultiEdit and Write from their input", () => {
    expect(kinds(editDiff("Edit", { file_path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" })!)).toEqual(["del:const a = 1;", "add:const a = 2;"]);
    expect(kinds(editDiff("MultiEdit", { edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: "z" }] })!)).toEqual(["del:x", "add:y", "gap", "add:z"]);
    const write = editDiff("Write", { content: "eins\nzwei\n" })!;
    expect(kinds(write)).toEqual(["add:eins", "add:zwei"]);
    expect(diffStats(write)).toEqual({ add: 2, del: 0 });
    expect(editDiff("Bash", { command: "ls" })).toBeNull();
  });
});

describe("output preview", () => {
  it("shows the first lines and counts the rest", () => {
    expect(splitPreview("1\n2\n3\n4\n5\n6", 4)).toEqual({ lines: ["1", "2", "3", "4"], hidden: 2, cut: false });
    expect(splitPreview("1\n2", Infinity)).toEqual({ lines: ["1", "2"], hidden: 0, cut: false });
    const long = splitPreview("x".repeat(500), 4);
    expect(long.cut).toBe(true);
    expect(long.lines[0]!.length).toBeLessThan(310);
  });

  it("drops reminders meant for the model and trailing blank lines", () => {
    expect(cleanToolOutput("ok\n\n<system-reminder>\nnicht zeigen\n</system-reminder>\n")).toBe("ok");
    expect(countLines("     1\tconst a\n     2\tconst b\n<system-reminder>x</system-reminder>")).toBe(2);
    expect(countLines("")).toBe(0);
  });
});
