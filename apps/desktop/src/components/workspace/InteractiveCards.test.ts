import { describe, expect, it } from "vitest";
import { buildAnswers, parseQuestions } from "./InteractiveCards";
import { contextTone } from "./ContextMeter";

const questions = parseQuestions({
  questions: [
    { question: "Welche Datenbank?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] },
    { question: "Welche Extras?", header: "Extras", multiSelect: true, options: [{ label: "Auth", description: "" }, { label: "Mail", description: "", preview: "x" }] },
    { broken: true },
  ],
});

describe("question answers", () => {
  it("reads questions defensively", () => {
    expect(questions).toHaveLength(2);
    expect(questions[1]).toMatchObject({ multiSelect: true, options: [{ label: "Auth" }, { label: "Mail", preview: "x" }] });
    expect(parseQuestions({})).toEqual([]);
  });

  it("answers with the label, joins multi-select picks and prefers own text for single choice", () => {
    expect(buildAnswers(questions, [["SQLite"], ["Auth", "Mail"]], ["", ""])).toEqual({ "Welche Datenbank?": "SQLite", "Welche Extras?": "Auth, Mail" });
    expect(buildAnswers(questions, [["SQLite"], ["Auth"]], ["MySQL", "Webhooks"])).toEqual({ "Welche Datenbank?": "MySQL", "Welche Extras?": "Auth, Webhooks" });
    expect(buildAnswers(questions, [[], []], ["  ", ""])).toEqual({});
  });
});

describe("context meter", () => {
  it("warns from 70 percent and alarms from 90", () => {
    expect(contextTone(69)).toBe("ok");
    expect(contextTone(70)).toBe("warn");
    expect(contextTone(90)).toBe("danger");
    expect(contextTone(130)).toBe("danger");
  });
});
