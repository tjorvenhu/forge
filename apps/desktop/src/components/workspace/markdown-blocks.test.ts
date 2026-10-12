import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./Markdown";
import { cachedEditDiff, inputJson } from "./tool-view";

describe("streaming markdown blocks", () => {
  it("splits at blank lines and keeps code fences whole", () => {
    const text = "Erster Absatz\nnoch dabei\n\n- Punkt\n- Punkt\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n\nEnde";
    expect(splitMarkdownBlocks(text)).toEqual(["Erster Absatz\nnoch dabei", "- Punkt\n- Punkt", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Ende"]);
  });

  it("keeps an unclosed fence (still streaming) in the last block", () => {
    expect(splitMarkdownBlocks("Hier:\n\n~~~\nzeile\n\nweiter")).toEqual(["Hier:", "~~~\nzeile\n\nweiter"]);
  });

  it("leaves finished blocks unchanged while the text grows", () => {
    const a = splitMarkdownBlocks("Eins.\n\nZwei");
    const b = splitMarkdownBlocks("Eins.\n\nZwei und drei");
    expect(b[0]).toBe(a[0]);
  });
});

describe("tool card caches", () => {
  it("computes the diff and the JSON of one input once", () => {
    const input = { old_string: "a\nb", new_string: "a\nc" };
    expect(cachedEditDiff("Edit", input)).toBe(cachedEditDiff("Edit", input));
    expect(inputJson(input)).toBe(JSON.stringify(input, null, 2));
  });
});
