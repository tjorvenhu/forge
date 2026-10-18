import { describe, expect, it } from "vitest";
import { findMatches, findPattern, findWords, fold } from "./find-text";

const marked = (text: string, query: string, phrase = false) =>
  findMatches(text, findPattern(findWords(query), phrase)).map(([a, b]) => text.slice(a, b));

describe("search in the chat: matching on screen", () => {
  it("reads plain words like the sidecar, folded", () => {
    expect(findWords("  Stripe-Webhook (Größe) \"foo*\"")).toEqual(["stripe", "webhook", "große", "foo"]);
    expect(findWords("***")).toEqual([]);
    expect(findWords("a b c d e f g h i j")).toHaveLength(8);
  });

  it("folds case and accents and keeps the offsets of the original text", () => {
    const f = fold("Ärger İst");
    expect(f.text).toBe("arger ist");
    expect(f.starts[0]).toBe(0);
    expect(f.ends[f.ends.length - 1]).toBe("Ärger İst".length);
  });

  it("marks every word at the start of a word, in any order, ignoring case and umlauts", () => {
    expect(marked("Der Webhook für Stripe läuft, stripe_webhook auch", "stripe webh")).toEqual(["Webh", "Stripe", "stripe"]);
    expect(marked("Die Migration läuft", "LAUFT")).toEqual(["läuft"]);
    expect(marked("Überprüfung", "uberpr")).toEqual(["Überpr"]);
    // Only at the start of a word, like the full-text index.
    expect(marked("remigration", "migration")).toEqual([]);
  });

  it("with phrase only marks the words in this order next to each other", () => {
    expect(marked("Stripe Webhook und Webhook für Stripe", "stripe webhook", true)).toEqual(["Stripe Webhook"]);
    expect(marked("src/stripe/webhook.ts", "stripe webhook", true)).toEqual(["stripe/webhook"]);
    expect(marked("Webhook für Stripe", "stripe webhook", true)).toEqual([]);
  });

  it("merges overlapping matches", () => {
    expect(findMatches("Webhooks", findPattern(["web", "webhook"], false))).toEqual([[0, 7]]);
    expect(findMatches("", findPattern(["x"], false))).toEqual([]);
    expect(findMatches("x", null)).toEqual([]);
  });
});
