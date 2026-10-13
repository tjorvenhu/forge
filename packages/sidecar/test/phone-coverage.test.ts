import { describe, expect, it } from "vitest";
import { methods } from "@forge/protocol";
import { NOT_ON_PHONE, PHONE_TOOL_FOR } from "../src/phone/coverage.js";
import { PHONE_TOOLS } from "../src/phone/tools.js";

describe("every FORGE function on the phone", () => {
  const all = Object.keys(methods);
  const tools = new Set(PHONE_TOOLS.map((t) => t.name));

  it("maps every RPC method to a phone tool or names why it is not on the phone", () => {
    const missing = all.filter((m) => !(m in PHONE_TOOL_FOR) && !(m in NOT_ON_PHONE));
    expect(missing, "RPC-Methoden ohne Telefon-Werkzeug: Werkzeug in phone/tools.ts ergänzen und in phone/coverage.ts eintragen, oder dort mit Grund ausnehmen").toEqual([]);
  });

  it("lists a method only once and only methods that exist", () => {
    expect(Object.keys(PHONE_TOOL_FOR).filter((m) => m in NOT_ON_PHONE)).toEqual([]);
    expect([...Object.keys(PHONE_TOOL_FOR), ...Object.keys(NOT_ON_PHONE)].filter((m) => !all.includes(m))).toEqual([]);
  });

  it("names only phone tools that exist", () => {
    expect(Object.entries(PHONE_TOOL_FOR).filter(([, tool]) => !tool || !tools.has(tool))).toEqual([]);
  });

  it("gives a reason for every exception", () => {
    expect(Object.entries(NOT_ON_PHONE).filter(([, why]) => !why || why.trim().length < 15)).toEqual([]);
  });
});
