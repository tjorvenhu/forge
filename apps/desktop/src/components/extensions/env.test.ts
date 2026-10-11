import { describe, expect, it } from "vitest";
import { parseEnvLines } from "./env";

describe("parseEnvLines", () => {
  it("parses NAME=wert lines and keeps = inside the value", () => {
    expect(parseEnvLines("API_KEY=abc\n\n  URL=https://x?a=b  \r\nEMPTY=")).toEqual({ env: { API_KEY: "abc", URL: "https://x?a=b", EMPTY: "" }, error: null });
  });

  it("rejects a line without =", () => {
    const r = parseEnvLines("A=1\nFOO");
    expect(r.env).toBeNull();
    expect(r.error).toContain("„FOO“");
  });

  it("rejects invalid names", () => {
    expect(parseEnvLines("1X=2").error).toContain("„1X“");
    expect(parseEnvLines("=wert").error).toContain("„=wert“");
  });
});
