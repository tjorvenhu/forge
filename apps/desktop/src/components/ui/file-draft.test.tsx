import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useFileDraft } from "./file-draft";

type Props = { content: string | undefined; version: number | null | undefined; key?: string };

function setup(initial: Props) {
  return renderHook((p: Props) => useFileDraft(p.content, p.version, p.key), { initialProps: initial });
}

describe("useFileDraft", () => {
  it("follows the file while the editor is clean", () => {
    const h = setup({ content: "a", version: 1 });
    h.rerender({ content: "b", version: 2 });
    expect(h.result.current.externalChange).toBe(false);
    expect(h.result.current.expectedVersion).toBe(2);
  });

  it("keeps a dirty draft and reports the outside change", () => {
    const h = setup({ content: "a", version: 1 });
    act(() => h.result.current.setDraft("mine"));
    h.rerender({ content: "theirs", version: 2 });
    expect(h.result.current.draft).toBe("mine");
    expect(h.result.current.externalChange).toBe(true);
    expect(h.result.current.expectedVersion).toBe(1);
  });

  it("reload drops the draft, keepEditing keeps it and takes the new version", () => {
    const h = setup({ content: "a", version: 1 });
    act(() => h.result.current.setDraft("mine"));
    h.rerender({ content: "theirs", version: 2 });
    act(() => h.result.current.keepEditing());
    expect(h.result.current.draft).toBe("mine");
    expect(h.result.current.externalChange).toBe(false);
    expect(h.result.current.expectedVersion).toBe(2);

    h.rerender({ content: "again", version: 3 });
    expect(h.result.current.externalChange).toBe(true);
    act(() => h.result.current.reload());
    expect(h.result.current.draft).toBeNull();
    expect(h.result.current.externalChange).toBe(false);
    expect(h.result.current.expectedVersion).toBe(3);
  });

  it("resets when the key changes", () => {
    const h = setup({ content: "a", version: 1, key: "user" });
    act(() => h.result.current.setDraft("mine"));
    h.rerender({ content: undefined, version: undefined, key: "project" });
    expect(h.result.current.draft).toBeNull();
    h.rerender({ content: "p", version: 5, key: "project" });
    expect(h.result.current.externalChange).toBe(false);
    expect(h.result.current.expectedVersion).toBe(5);
  });

  it("clears the draft after it was saved", () => {
    const h = setup({ content: "a", version: 1 });
    act(() => h.result.current.setDraft("b"));
    h.rerender({ content: "b", version: 2 });
    expect(h.result.current.draft).toBeNull();
    expect(h.result.current.dirty).toBe(false);
  });
});
