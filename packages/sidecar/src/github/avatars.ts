/** Pixel size requested from GitHub; rows show 16 px, so this stays sharp on high-DPI screens. */
export const AVATAR_SIZE = 64;

const NOREPLY = /^(?:(\d+)\+)?([^@\s]+)@users\.noreply\.github\.com$/i;

/**
 * GitHub picture for a commit email that already names the account: `<id>+<login>@users.noreply.github.com`
 * or the older `<login>@users.noreply.github.com`. Other emails need a lookup on GitHub.
 * Only avatars.githubusercontent.com: the CSP of the app allows images from there and nowhere else.
 */
export function avatarFromEmail(email: string): string | null {
  const m = NOREPLY.exec(email.trim());
  if (!m) return null;
  if (m[1]) return `https://avatars.githubusercontent.com/u/${m[1]}?s=${AVATAR_SIZE}&v=4`;
  const login = m[2]!;
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? `https://avatars.githubusercontent.com/${login}?s=${AVATAR_SIZE}` : null;
}

export const avatarKey = (email: string) => email.trim().toLowerCase();

/**
 * Commits to ask GitHub about, at most two per author email: the oldest and the newest in the list
 * (the log starts at HEAD). The oldest is the most likely to be pushed already; the newest covers
 * an author whose older commits are not loaded. Emails in `skip` (keys from avatarKey) are left out.
 */
export function commitsToResolve(
  commits: ReadonlyArray<{ hash: string; authorEmail: string }>,
  skip: (key: string) => boolean,
  maxAuthors = 50,
): Map<string, string[]> {
  const byEmail = new Map<string, string[]>();
  for (const c of commits) {
    const key = avatarKey(c.authorEmail);
    if (!key || !/^[0-9a-f]{40}$/i.test(c.hash) || skip(key)) continue;
    const list = byEmail.get(key);
    if (!list) {
      if (byEmail.size >= maxAuthors) continue;
      byEmail.set(key, [c.hash]);
    } else {
      list[1] = c.hash;
    }
  }
  return byEmail;
}

/** One GraphQL request for all commits; the aliases c0, c1, … follow the order of `hashes`. */
export function authorsQuery(hashes: readonly string[]): string {
  const fields = hashes.map((h, i) => `c${i}: object(oid: "${h}") { ... on Commit { author { user { avatarUrl(size: ${AVATAR_SIZE}) } } } }`);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;
}

/** Avatar URL per alias index from the GraphQL answer; missing commits and authors without an account are null. */
type AuthorsAnswer = Record<string, { author?: { user?: { avatarUrl?: unknown } | null } | null } | null>;

export function parseAuthorsResponse(stdout: string, count: number): Array<string | null> {
  let repo: AuthorsAnswer | null;
  try {
    const j = JSON.parse(stdout) as { data?: { repository?: AuthorsAnswer | null } | null } | null;
    repo = j?.data?.repository ?? null;
  } catch {
    repo = null;
  }
  return Array.from({ length: count }, (_, i) => {
    const url = repo?.[`c${i}`]?.author?.user?.avatarUrl;
    return typeof url === "string" && url.startsWith("https://avatars.githubusercontent.com/") ? url : null;
  });
}
