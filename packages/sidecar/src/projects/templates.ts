import type { ProjectTemplate } from "@forge/protocol";

export function gitignoreFor(template: ProjectTemplate): string {
  const common = ["# Betriebssystem", ".DS_Store", "Thumbs.db", "", "# Secrets", ".env", ".env.*", "!.env.example", "", "# Claude lokal", ".claude/settings.local.json", ""];
  const byTemplate: Record<ProjectTemplate, string[]> = {
    empty: [],
    "node-ts": ["# Node", "node_modules/", "dist/", "coverage/", "*.log", ""],
    python: ["# Python", "__pycache__/", "*.py[cod]", ".venv/", "venv/", ".pytest_cache/", "dist/", "*.egg-info/", ""],
    rust: ["# Rust", "target/", ""],
  };
  return [...common, ...byTemplate[template]].join("\n");
}

export function readmeFor(name: string): string {
  return `# ${name}\n`;
}

export function claudeMdFor(name: string, template: ProjectTemplate): string {
  const stack: Record<ProjectTemplate, string> = {
    empty: "",
    "node-ts": "\n## Stack\n\n- Node.js mit TypeScript, Paketmanager pnpm\n",
    python: "\n## Stack\n\n- Python\n",
    rust: "\n## Stack\n\n- Rust (cargo)\n",
  };
  return `# ${name}\n\nProjektregeln für Claude Code.\n${stack[template]}`;
}

/** Extra starter files per template (relative path -> content). */
export function starterFiles(name: string, template: ProjectTemplate): Record<string, string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "projekt";
  switch (template) {
    case "node-ts":
      return {
        "package.json": JSON.stringify(
          { name: slug, version: "0.1.0", private: true, type: "module", scripts: { build: "tsc", typecheck: "tsc --noEmit" } },
          null,
          2,
        ) + "\n",
        "tsconfig.json": JSON.stringify(
          { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist" }, include: ["src"] },
          null,
          2,
        ) + "\n",
        "src/index.ts": "export {};\n",
      };
    case "python":
      return {
        "pyproject.toml": `[project]\nname = "${slug}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n`,
        [`src/${slug.replace(/-/g, "_")}/__init__.py`]: "",
      };
    case "rust":
      return {
        "Cargo.toml": `[package]\nname = "${slug}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
        "src/main.rs": 'fn main() {\n    println!("Hallo");\n}\n',
      };
    default:
      return {};
  }
}
