import { describe, expect, it } from "vitest";
import { fromAcceptLanguage, pickLocale } from "./i18n";

describe("fromAcceptLanguage", () => {
  it("takes the first supported language by weight", () => {
    expect(fromAcceptLanguage("de-AT,de;q=0.9,en;q=0.8")).toBe("de");
    expect(fromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7")).toBe("de");
    expect(fromAcceptLanguage("en;q=0.5,de;q=0.9")).toBe("de");
    expect(fromAcceptLanguage("en-GB")).toBe("en");
  });

  it("ignores unsupported and excluded languages", () => {
    expect(fromAcceptLanguage("fr,es;q=0.5")).toBeNull();
    expect(fromAcceptLanguage("de;q=0,fr")).toBeNull();
    expect(fromAcceptLanguage("")).toBeNull();
    expect(fromAcceptLanguage(null)).toBeNull();
  });
});

describe("pickLocale", () => {
  it("prefers the cookie, then the browser, then English", () => {
    expect(pickLocale("en", "de-DE")).toBe("en");
    expect(pickLocale("de", "en-US")).toBe("de");
    expect(pickLocale(undefined, "de-DE,de")).toBe("de");
    expect(pickLocale("xx", "fr")).toBe("en");
    expect(pickLocale(undefined, undefined)).toBe("en");
  });
});
