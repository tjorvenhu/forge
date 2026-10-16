import { describe, expect, it } from "vitest";
import { fillTemplate, findTemplates, knownTemplateValues, suggestTemplates, templatePlaceholders, templateScore } from "./templates.js";

const tpl = (name: string, text: string, description: string | null = null) => ({ id: name, name, text, description });
const review = tpl("Review vor Release", "Mach ein gründliches Review aller Änderungen seit dem letzten Release-Tag. Achte auf Fehler, Sicherheit und fehlende Tests.");
const tests = tpl("Tests schreiben", "Schreib Tests für die geänderten Dateien: {datei}. Nutze vitest wie in den vorhandenen Tests.");
const changelog = tpl("Changelog", "Fasse die Commits seit {version} als Changelog auf Deutsch zusammen.", "Für die Release-Notizen");
const all = [review, tests, changelog];

describe("placeholders", () => {
  it("finds each placeholder once, in order, and ignores code braces", () => {
    expect(templatePlaceholders("Tests für {datei} zu {thema}, nochmal {Datei}")).toEqual(["datei", "thema"]);
    expect(templatePlaceholders('const x = { a: 1 }; JSON {"a":1} und {} und {mit leerzeichen}')).toEqual([]);
    expect(templatePlaceholders("{ä-ü_1}")).toEqual(["ä-ü_1"]);
  });

  it("fills known values case-insensitively and leaves empty or unknown ones", () => {
    expect(fillTemplate("Prüfe {Datei} für {thema} in {projekt}", { datei: "src/a.ts", thema: "  ", other: "x" })).toBe("Prüfe src/a.ts für {thema} in {projekt}");
  });

  it("knows project, branch, file and date, under German and English names", () => {
    expect(knownTemplateValues("{projekt} {branch} {datei} {date} {thema}", { project: "shop", branch: "main", file: null, date: "2026-10-16" })).toEqual({ projekt: "shop", branch: "main", date: "2026-10-16" });
  });
});

describe("suggestions while typing", () => {
  it("stays quiet for short input and long messages", () => {
    expect(suggestTemplates("Rev", all)).toEqual([]);
    expect(suggestTemplates("Mach", all)).toEqual([]);
    expect(suggestTemplates(`review ${"x ".repeat(200)}`, all)).toEqual([]);
  });

  it("suggests by the beginning of the name or of the text", () => {
    expect(suggestTemplates("revi", all)).toEqual([review]);
    expect(suggestTemplates("Mach ein gründl", all)).toEqual([review]);
    expect(suggestTemplates("changelog", all)).toEqual([changelog]);
  });

  it("matches words in another form, accents and a typo", () => {
    expect(suggestTemplates("tests für geänderte dateien", all)).toEqual([tests]);
    expect(suggestTemplates("schreib tests fur die geanderten", all)).toEqual([tests]);
    expect(suggestTemplates("Reveiw vor Release", all)).toEqual([review]);
  });

  it("does not suggest for a message that only shares a word or two", () => {
    expect(suggestTemplates("schreib tests für das neue login und die registrierung", all)).toEqual([]);
    expect(suggestTemplates("Ich sehe einen Fehler in der Sicherheit", all)).toEqual([]);
    // A single common word from the text, not the name.
    expect(suggestTemplates("gründlich", all)).toEqual([]);
  });

  it("does not suggest the template that is already in the field", () => {
    expect(templateScore(review.text, review)).toBe(0);
  });

  it("ranks better matches first and keeps the list order on a tie", () => {
    const a = tpl("Tests A", "Tests für A");
    const b = tpl("Tests B", "Tests für B");
    expect(suggestTemplates("tests", [a, b, tests]).map((t) => t.name)).toEqual(["Tests A", "Tests B", "Tests schreiben"]);
    expect(suggestTemplates("tests schreiben", [a, b, tests])[0]).toBe(tests);
  });
});

describe("explicit search", () => {
  it("lists everything for an empty query, else name hits before text hits", () => {
    expect(findTemplates("", all)).toEqual(all);
    expect(findTemplates("rel", all)).toEqual([review, changelog]);
    expect(findTemplates("vitest", all)).toEqual([tests]);
    expect(findTemplates("nichts davon", all)).toEqual([]);
  });
});
