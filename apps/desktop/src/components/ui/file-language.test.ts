import { describe, expect, it } from "vitest";
import { languageFor } from "./file-language";

const lang = (p: string) => languageFor(p)?.name ?? null;

describe("languageFor", () => {
  it("picks the language by extension, case-insensitive and with Windows paths", () => {
    expect(lang("src/App.tsx")).toBe("TSX");
    expect(lang("src\\lib\\utils.ts")).toBe("TypeScript");
    expect(lang("scripts/build.mjs")).toBe("JavaScript");
    expect(lang("README.MD")).toBe("Markdown");
    expect(lang("styles.css")).toBe("CSS");
    expect(lang("main.py")).toBe("Python");
    expect(lang("src-tauri/src/main.rs")).toBe("Rust");
    expect(lang("pnpm-workspace.yaml")).toBe("YAML");
  });

  it("knows project files without a usable extension", () => {
    expect(lang("Dockerfile")).toBe("Dockerfile");
    expect(lang("Dockerfile.prod")).toBe("Dockerfile");
    expect(lang(".env.local")).toBe("Properties files");
    expect(lang(".gitignore")).toBe("Properties files");
    expect(lang("tsconfig.jsonc")).toBe("JSON");
  });

  it("falls back to plain text", () => {
    expect(lang("LICENSE")).toBeNull();
    expect(lang("notes.unknownext")).toBeNull();
  });
});
