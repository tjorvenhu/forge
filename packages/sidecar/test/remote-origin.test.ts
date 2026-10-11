import { describe, expect, it } from "vitest";
import { fromHuman } from "../src/sessions/remote-bridge.js";

const user = (content: unknown, origin?: unknown) => ({ type: "user", isReplay: true, uuid: "u1", message: { role: "user", content }, ...(origin ? { origin } : {}) });

describe("fromHuman", () => {
  it("accepts messages a person wrote", () => {
    expect(fromHuman(user("Bitte die Tests reparieren", { kind: "human" }))).toBe(true);
    expect(fromHuman(user([{ type: "text", text: "Hallo" }]))).toBe(true);
  });

  it("skips Claude Code's own notifications", () => {
    const note = "<task-notification>\n<task-id>b0g01n2xk</task-id>\n<status>completed</status>\n</task-notification>";
    expect(fromHuman(user(note, { kind: "task-notification" }))).toBe(false);
    expect(fromHuman(user(note))).toBe(false);
    expect(fromHuman(user([{ type: "text", text: "<system-reminder>x</system-reminder>" }]))).toBe(false);
    expect(fromHuman(user("Nachricht", { kind: "peer", from: "other" }))).toBe(false);
  });
});
