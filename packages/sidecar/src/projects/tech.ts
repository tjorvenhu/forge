import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Detects technologies from marker files in the project root. Read-only, best effort. */
export async function detectTechnologies(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const has = (f: string) => entries.includes(f);
  const tech = new Set<string>();

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const map: Array<[string, string]> = [
        ["next", "Next.js"],
        ["react", "React"],
        ["vue", "Vue"],
        ["svelte", "Svelte"],
        ["@angular/core", "Angular"],
        ["vite", "Vite"],
        ["express", "Express"],
        ["@tauri-apps/api", "Tauri"],
        ["electron", "Electron"],
        ["tailwindcss", "Tailwind"],
        ["prisma", "Prisma"],
        ["drizzle-orm", "Drizzle"],
      ];
      for (const [dep, label] of map) if (dep in deps) tech.add(label);
      if ("typescript" in deps || has("tsconfig.json")) tech.add("TypeScript");
      else tech.add("JavaScript");
    } catch {
      tech.add("Node.js");
    }
  }
  if (has("pnpm-lock.yaml")) tech.add("pnpm");
  if (has("Cargo.toml")) tech.add("Rust");
  if (has("go.mod")) tech.add("Go");
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) tech.add("Python");
  if (has("Gemfile")) tech.add("Ruby");
  if (has("composer.json")) tech.add("PHP");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) tech.add("Java/Kotlin");
  if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) tech.add(".NET");
  if (has("Dockerfile") || has("docker-compose.yml") || has("compose.yaml")) tech.add("Docker");
  if (has("CLAUDE.md") || has(".claude")) tech.add("Claude");
  return [...tech];
}
