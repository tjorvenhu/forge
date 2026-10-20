import { describe, expect, it } from "vitest";
import { DevChannelService } from "../src/update/dev-channel.js";

type Reply = { code: number; stdout?: string; stderr?: string };

/** gh with canned answers per command line; records every call. */
function fakeGh(answers: Record<string, Reply>) {
  const calls: string[] = [];
  const gh = async (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers).find((k) => line.startsWith(k));
    const r = key ? answers[key]! : { code: 1, stderr: `unexpected: ${line}` };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { gh, calls };
}

const MEMBER: Record<string, Reply> = {
  "auth token": { code: 0, stdout: "gho_x\n" },
  "api user": { code: 0, stdout: "tjorvenhu\n" },
  "api repos/vanturis/forge --jq": { code: 0, stdout: "true\n" },
  "api repos/vanturis/forge/compare/main...dev": {
    code: 0,
    stdout: JSON.stringify({ ahead_by: 2, behind_by: 0, commits: [{ commit: { message: "feat: eins\n\ndetails" } }, { commit: { message: "fix: zwei" } }] }),
  },
};

function service(answers: Record<string, Reply>, setting: "stable" | "dev" = "dev") {
  const { gh, calls } = fakeGh(answers);
  return { svc: new DevChannelService({ setting: () => setting, log: () => {}, gh, hasGh: () => true }), calls };
}

describe("dev channel", () => {
  it("lets a member with push access use dev and lists what dev brings", async () => {
    const { svc } = service(MEMBER);
    expect(await svc.state()).toMatchObject({ allowed: true, reason: "ok", login: "tjorvenhu", ahead: 2, behind: 0, commits: ["fix: zwei", "feat: eins"] });
    expect(await svc.effective()).toBe("dev");
  });

  it("refuses accounts without push access and without login, and checks main then", async () => {
    const reader = service({ ...MEMBER, "api repos/vanturis/forge --jq": { code: 0, stdout: "false\n" } });
    expect(await reader.svc.state()).toMatchObject({ allowed: false, reason: "no-access", login: "tjorvenhu", ahead: null });
    expect(await reader.svc.effective()).toBe("stable");
    await expect(reader.svc.requireAccess()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const nobody = service({ "auth token": { code: 1, stderr: "not logged in" } });
    expect(await nobody.svc.state()).toMatchObject({ allowed: false, reason: "no-login" });
    await expect(nobody.svc.promote(true)).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("does not ask GitHub while the stable channel is chosen", async () => {
    const { svc, calls } = service(MEMBER, "stable");
    expect(await svc.effective()).toBe("stable");
    expect(calls).toEqual([]);
  });

  it("fast-forwards main to dev and starts the release of main", async () => {
    const { svc, calls } = service({
      ...MEMBER,
      "api repos/vanturis/forge/git/ref/heads/dev": { code: 0, stdout: "abc1234\n" },
      "api -X PATCH repos/vanturis/forge/git/refs/heads/main": { code: 0, stdout: "{}" },
      "api -X POST repos/vanturis/forge/actions/workflows/release.yml/dispatches": { code: 0 },
    });
    expect(await svc.promote(true)).toEqual({ mode: "fast-forward", sha: "abc1234", releaseStarted: true });
    expect(calls).toContain("api -X PATCH repos/vanturis/forge/git/refs/heads/main -f sha=abc1234 -F force=false");
    expect(calls).toContain("api -X POST repos/vanturis/forge/actions/workflows/release.yml/dispatches -f ref=main");
  });

  it("merges when main has commits of its own and reports conflicts", async () => {
    const behind = { ...MEMBER, "api repos/vanturis/forge/compare/main...dev": { code: 0, stdout: JSON.stringify({ ahead_by: 1, behind_by: 3, commits: [] }) } };
    const merged = service({ ...behind, "api -X POST repos/vanturis/forge/merges": { code: 0, stdout: "def5678\n" } });
    expect(await merged.svc.promote(false)).toEqual({ mode: "merge", sha: "def5678", releaseStarted: false });
    const conflict = service({ ...behind, "api -X POST repos/vanturis/forge/merges": { code: 1, stderr: "gh: Merge conflict (HTTP 409)" } });
    await expect(conflict.svc.promote(false)).rejects.toMatchObject({ code: "GIT_FAILED" });
  });

  it("says when there is no dev branch yet", async () => {
    const { svc } = service({ ...MEMBER, "api repos/vanturis/forge/compare/main...dev": { code: 1, stderr: "gh: Not Found (HTTP 404)" } });
    const st = await svc.state();
    expect(st).toMatchObject({ allowed: true, ahead: null });
    expect(st.message).toMatch(/dev/);
    await expect(svc.promote(true)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
