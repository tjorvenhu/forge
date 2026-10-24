import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@forge/protocol";
import { authForm, authPayload, authProblem, EMPTY_AUTH } from "./mcp";

const cfg = (c: Partial<McpServerConfig>): McpServerConfig => ({ name: "api", scope: "user", transport: "http", target: "https://x", args: [], env: {}, headers: {}, oauth: null, ...c });

describe("MCP authentication fields", () => {
  it("turns an Authorization: Bearer header into the token field and keeps the other headers", () => {
    const form = authForm(cfg({ headers: { authorization: "Bearer abc", "X-Team": "a: b" } }));
    expect(form).toMatchObject({ kind: "bearer", token: "abc", headers: "X-Team: a: b" });
    expect(authPayload(form, { "X-Team": "a: b" })).toEqual({ headers: { "X-Team": "a: b", Authorization: "Bearer abc" } });
  });

  it("keeps an OAuth client and sends the secret only when one was entered", () => {
    const form = authForm(cfg({ oauth: { clientId: "cid", callbackPort: 8123 } }));
    expect(form).toMatchObject({ kind: "oauth", clientId: "cid", callbackPort: "8123" });
    expect(authPayload(form, {}).oauth).toEqual({ clientId: "cid", callbackPort: 8123 });
    expect(authPayload({ ...form, clientSecret: "s" }, {}).oauth).toEqual({ clientId: "cid", clientSecret: "s", callbackPort: 8123 });
  });

  it("does not double the Bearer prefix and builds an API key header", () => {
    expect(authPayload({ ...EMPTY_AUTH, kind: "bearer", token: " Bearer xyz " }, {}).headers).toEqual({ Authorization: "Bearer xyz" });
    expect(authPayload({ ...EMPTY_AUTH, kind: "apiKey", keyValue: "k" }, {}).headers).toEqual({ "X-API-Key": "k" });
  });

  it("asks for what the chosen kind needs", () => {
    expect(authProblem({ ...EMPTY_AUTH, kind: "bearer" }).incomplete).toBe(true);
    expect(authProblem({ ...EMPTY_AUTH, kind: "apiKey", keyHeader: "X Key", keyValue: "k" }).incomplete).toBe(true);
    expect(authProblem({ ...EMPTY_AUTH, kind: "oauth", clientId: "c", callbackPort: "70000" }).error).toBeTruthy();
    expect(authProblem(EMPTY_AUTH)).toEqual({ incomplete: false, error: null });
  });
});
