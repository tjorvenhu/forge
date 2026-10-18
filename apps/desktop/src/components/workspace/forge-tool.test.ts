import { describe, expect, it } from "vitest";
import { forgeToolView } from "./forge-tool";

const done = (text: string) => ({ text, isError: false });

// The sidecar writes the results in the language set when the tool ran; the cards read both.
describe("forgeToolView in both languages", () => {
  it("recognizes a saved entry that overlaps", () => {
    for (const text of [
      "Gespeichert: abc (.forge/knowledge/abc.md). Überschneidet sich stark mit: x.",
      "Saved: abc (.forge/knowledge/abc.md). Overlaps heavily with: x.",
    ]) {
      const v = forgeToolView("knowledge_save", { title: "T" }, done(text));
      expect(v.tone).toBe("warning");
      expect(v.target).toEqual({ kind: "knowledge", id: "abc" });
    }
  });

  it("recognizes errors, the reached limit and an aborted interaction", () => {
    expect(forgeToolView("knowledge_read", {}, done("Error: no entry")).tone).toBe("danger");
    expect(forgeToolView("usage_status", {}, done("Limit reached. New turns fail until then.\n5 hours: 100% used")).tone).toBe("warning");
    expect(forgeToolView("usage_status", {}, done("5 Stunden: 23 % genutzt")).ref).toBe("23 %");
    expect(forgeToolView("preview_screenshot", {}, done("Address: http://localhost:3000\nConsole: 2 errors")).tone).toBe("warning");
    expect(forgeToolView("preview_screenshot", {}, done("Adresse: http://localhost:3000\nKonsole: keine Meldungen")).tone).toBe("accent");
  });
});
