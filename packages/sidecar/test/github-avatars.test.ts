import { describe, expect, it } from "vitest";
import { authorsQuery, avatarFromEmail, commitsToResolve, parseAuthorsResponse } from "../src/github/avatars.js";

const h = (c: string) => c.repeat(40);

describe("avatarFromEmail", () => {
  it("maps GitHub noreply addresses, with and without id", () => {
    expect(avatarFromEmail("583231+octocat@users.noreply.github.com")).toBe("https://avatars.githubusercontent.com/u/583231?s=64&v=4");
    expect(avatarFromEmail(" Octocat@Users.NoReply.GitHub.com ")).toBe("https://avatars.githubusercontent.com/Octocat?s=64");
    expect(avatarFromEmail("41898282+github-actions[bot]@users.noreply.github.com")).toBe("https://avatars.githubusercontent.com/u/41898282?s=64&v=4");
  });

  it("leaves other emails and odd logins to the lookup", () => {
    expect(avatarFromEmail("jane@example.com")).toBeNull();
    expect(avatarFromEmail("")).toBeNull();
    expect(avatarFromEmail("a/b@users.noreply.github.com")).toBeNull();
    expect(avatarFromEmail("jane@users.noreply.github.com.evil.com")).toBeNull();
  });
});

describe("commitsToResolve", () => {
  it("takes the newest and the oldest commit per email and skips known ones", () => {
    const commits = [
      { hash: h("a"), authorEmail: "Jane@x.de" },
      { hash: h("b"), authorEmail: "joe@x.de" },
      { hash: h("c"), authorEmail: "jane@x.de" },
      { hash: h("d"), authorEmail: "jane@x.de" },
      { hash: h("e"), authorEmail: "known@x.de" },
      { hash: "not-a-hash", authorEmail: "bad@x.de" },
    ];
    const r = commitsToResolve(commits, (k) => k === "known@x.de");
    expect([...r.entries()]).toEqual([
      ["jane@x.de", [h("a"), h("d")]],
      ["joe@x.de", [h("b")]],
    ]);
  });

  it("caps the number of authors per request", () => {
    const commits = ["1", "2", "3"].map((c) => ({ hash: h(c), authorEmail: `${c}@x.de` }));
    expect([...commitsToResolve(commits, () => false, 2).keys()]).toEqual(["1@x.de", "2@x.de"]);
  });
});

describe("authors query", () => {
  it("asks for every commit under its own alias", () => {
    const q = authorsQuery([h("a"), h("b")]);
    expect(q).toContain(`c0: object(oid: "${h("a")}")`);
    expect(q).toContain(`c1: object(oid: "${h("b")}")`);
  });

  it("reads avatar URLs and treats missing commits, accounts and broken output as null", () => {
    const out = JSON.stringify({
      data: {
        repository: {
          c0: { author: { user: { avatarUrl: "https://avatars.githubusercontent.com/u/1?s=64&v=4" } } },
          c1: { author: { user: null } },
          c2: null,
          c3: { author: { user: { avatarUrl: "https://example.com/x.png" } } },
        },
      },
      errors: [{ message: "Could not resolve to a commit" }],
    });
    expect(parseAuthorsResponse(out, 5)).toEqual(["https://avatars.githubusercontent.com/u/1?s=64&v=4", null, null, null, null]);
    expect(parseAuthorsResponse("gh: not logged in", 2)).toEqual([null, null]);
  });
});
