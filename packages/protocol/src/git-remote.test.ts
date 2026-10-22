import { describe, expect, it } from "vitest";
import { convertRemoteUrl, isValidRemoteUrl, redactRemoteUrl, remoteIdentity, remoteKind } from "./git-remote.js";

describe("remoteKind", () => {
  it("tells https, ssh and the rest apart", () => {
    expect(remoteKind("https://github.com/vanturis/forge.git")).toBe("https");
    expect(remoteKind("http://git.example.com:8080/team/app")).toBe("https");
    expect(remoteKind("git@github.com:vanturis/forge.git")).toBe("ssh");
    expect(remoteKind("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("ssh");
    expect(remoteKind("C:\\repos\\app")).toBe("other");
    expect(remoteKind("/srv/git/app.git")).toBe("other");
    expect(remoteKind("file:///srv/git/app.git")).toBe("other");
  });
});

describe("convertRemoteUrl", () => {
  it("switches between https and ssh", () => {
    expect(convertRemoteUrl("https://github.com/vanturis/forge.git", "ssh")).toBe("git@github.com:vanturis/forge.git");
    expect(convertRemoteUrl("git@github.com:vanturis/forge.git", "https")).toBe("https://github.com/vanturis/forge.git");
    expect(convertRemoteUrl("ssh://git@gitlab.example.com:2222/team/app.git", "https")).toBe("https://gitlab.example.com/team/app.git");
  });

  it("drops credentials and ports", () => {
    expect(convertRemoteUrl("https://user:token@github.com/vanturis/forge/", "ssh")).toBe("git@github.com:vanturis/forge");
    expect(convertRemoteUrl("https://git.example.com:8443/team/app.git", "ssh")).toBe("git@git.example.com:team/app.git");
  });

  it("leaves local paths alone", () => {
    expect(convertRemoteUrl("C:\\repos\\app", "ssh")).toBeNull();
    expect(convertRemoteUrl("/srv/git/app.git", "https")).toBeNull();
  });
});

describe("redactRemoteUrl", () => {
  it("hides tokens and passwords but keeps the ssh user", () => {
    expect(redactRemoteUrl("https://ghp_abc@github.com/a/b.git")).toBe("https://***@github.com/a/b.git");
    expect(redactRemoteUrl("https://user:secret@github.com/a/b.git")).toBe("https://***@github.com/a/b.git");
    expect(redactRemoteUrl("ssh://git:secret@host/a/b.git")).toBe("ssh://git:***@host/a/b.git");
    expect(redactRemoteUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });
});

describe("isValidRemoteUrl", () => {
  it("refuses options, command transports and blanks", () => {
    expect(isValidRemoteUrl("git@github.com:a/b.git")).toBe(true);
    expect(isValidRemoteUrl("--upload-pack=evil")).toBe(false);
    expect(isValidRemoteUrl("ext::sh -c evil")).toBe(false);
    expect(isValidRemoteUrl("https://github.com/a b")).toBe(false);
    expect(isValidRemoteUrl("  ")).toBe(false);
  });
});

describe("remoteIdentity", () => {
  it("is the same over https and ssh", () => {
    expect(remoteIdentity("https://github.com/Vanturis/Forge.git")).toBe("github.com/vanturis/forge");
    expect(remoteIdentity("git@github.com:vanturis/forge.git")).toBe("github.com/vanturis/forge");
    expect(remoteIdentity("https://token@github.com/vanturis/forge")).toBe("github.com/vanturis/forge");
    expect(remoteIdentity("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("gitlab.example.com/team/app");
    expect(remoteIdentity("C:\\repos\\app\\")).toBe("C:\\repos\\app");
  });
});
