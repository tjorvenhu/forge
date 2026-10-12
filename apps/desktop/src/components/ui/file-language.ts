import { languages } from "@codemirror/language-data";

export type LanguageDescription = (typeof languages)[number];

const byName = (name: string) => languages.find((l) => l.name === name) ?? null;

// Common project files that language-data has no entry for, mapped to the closest language.
const EXTRA_EXTENSIONS: Record<string, string> = {
  jsonc: "JSON",
  json5: "JSON",
  "code-workspace": "JSON",
  svelte: "HTML",
  astro: "HTML",
  conf: "Properties files",
  cfg: "Properties files",
  zsh: "Shell",
};

/** Dotfiles without an extension that are line-based "key = value" or "# comment" formats. */
const PROPERTIES_DOTFILE = /^\.(env(\..+)?|npmrc|editorconfig|gitattributes|gitignore|dockerignore|prettierignore|eslintignore|nvmrc)$/i;

/** Picks the language for a file the way VS Code does: by file name first, then by extension. */
export function languageFor(path: string): LanguageDescription | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const named = languages.find((l) => l.filename?.test(name));
  if (named) return named;
  if (/^Dockerfile(\..+)?$/i.test(name) || /\.dockerfile$/i.test(name)) return byName("Dockerfile");
  if (PROPERTIES_DOTFILE.test(name)) return byName("Properties files");
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!ext) return null;
  const extra = EXTRA_EXTENSIONS[ext];
  if (extra) return byName(extra);
  return languages.find((l) => l.extensions.includes(ext)) ?? null;
}
