import { afterEach, describe, expect, it } from "vitest";
import { useUi } from "@/stores/ui";
import { composerFocused, registerComposer, screenshotTarget } from "./screenshot";

const offs: Array<() => void> = [];
afterEach(() => {
  while (offs.length) offs.pop()!();
  useUi.setState({ activeProjectId: null, activeSession: {} });
});

describe("screenshot target", () => {
  it("picks the composer typed in last, else the main chat, else the chat of the open project", () => {
    expect(screenshotTarget()).toBeNull();
    useUi.setState({ activeProjectId: "p1", activeSession: { p1: "s1" } });
    expect(screenshotTarget()).toBe("s1");

    offs.push(registerComposer("pane-session", false));
    offs.push(registerComposer("main-session", true));
    expect(screenshotTarget()).toBe("main-session");

    composerFocused("pane-session");
    expect(screenshotTarget()).toBe("pane-session");

    offs.pop()!();
    offs.pop()!();
    expect(screenshotTarget()).toBe("s1");
  });
});
