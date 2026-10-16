/**
 * The project files a name or path written by Claude refers to: a bare name matches the file name, a path
 * the whole path or its end (Claude often writes from the folder it worked in, src-tauri/Cargo.toml for
 * apps/desktop/src-tauri/Cargo.toml). Exact case first; only without a hit regardless of case.
 */
export function matchingFiles<F extends { name: string; path: string }>(files: F[], wanted: string): F[] {
  const w = wanted.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
  if (!w) return [];
  const find = (norm: (s: string) => string) => {
    const x = norm(w);
    if (!x.includes("/")) return files.filter((f) => norm(f.name) === x);
    const exact = files.filter((f) => norm(f.path) === x);
    return exact.length ? exact : files.filter((f) => norm(f.path).endsWith(`/${x}`));
  };
  const hits = find((s) => s);
  return hits.length ? hits : find((s) => s.toLowerCase());
}
