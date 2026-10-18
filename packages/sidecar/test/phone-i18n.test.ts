import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, tr } from "../src/i18n/index.js";
import { excerptData } from "../src/phone/session-info.js";
import { geminiFunctionDeclarations, phoneSystemPrompt, PHONE_TOOLS, runPhoneTool, type PhoneToolset } from "../src/phone/tools.js";

describe("phone in English", () => {
  afterEach(() => setLanguage("de"));

  it("instructs the model, describes the tools and answers in the language of the app", async () => {
    const de = phoneSystemPrompt("voice");
    expect(de).toContain("Du bist FORGE am Telefon");
    setLanguage("en");
    const en = phoneSystemPrompt("voice");
    expect(en).not.toContain("Du bist");
    expect(en).toMatch(/English/);
    // The data markers stay the same, so a call that switches language keeps its security rule.
    expect(en).toContain("<<<SESSION-DATEN>>>");

    const status = geminiFunctionDeclarations().find((d) => d.name === "status")!;
    expect(status.description).toBe(tr().phone.tools.status.description);
    expect(status.description).toMatch(/^Overview/);
    const details = PHONE_TOOLS.find((t) => t.name === "details")!;
    expect(details.params.session!.description).toBe(tr().phone.params.session);

    expect(excerptData("", 10)).toBe(tr().phone.pending.noText);
    expect(await runPhoneTool("nope", {}, {} as PhoneToolset, { hangup: () => {} })).toMatch(/^Error: /);
    expect(await runPhoneTool("hang_up", {}, {} as PhoneToolset, { hangup: () => {} })).toBe(tr().phone.hangUp);
    expect(tr().phone.hangUp).not.toBe("Das Gespräch wird beendet.");
  });

  it("has every German text in English, the tool descriptions included", () => {
    setLanguage("en");
    for (const t of PHONE_TOOLS) {
      expect(t.description, t.name).toBeTruthy();
      for (const [k, p] of Object.entries(t.params)) if (p.type !== "boolean" && p.type !== "number" && !p.enum) expect(p.description ?? "", `${t.name}.${k}`).not.toMatch(/[äöüß]/);
    }
  });
});
