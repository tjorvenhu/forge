import { createHash, randomBytes } from "node:crypto";

export const MAX_NEW_INSTALLS_PER_IP_PER_DAY = 20;

/** Per-process salt: the hashes cannot be matched against IP addresses, and they vanish with the process. */
const salt = randomBytes(32);

export function hashIp(ip: string): string {
  return createHash("sha256").update(salt).update(ip).digest("base64url");
}

/**
 * Client address as Traefik passes it on. X-Real-Ip is set by Traefik itself; of X-Forwarded-For only the
 * last entry is trustworthy, because Traefik appends the address it saw to whatever the client sent.
 */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim();
  return last || "unknown";
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Counts new installation IDs per hashed IP and UTC day, in memory only. */
export class NewInstallLimiter {
  private day = "";
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly max = MAX_NEW_INSTALLS_PER_IP_PER_DAY,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registers `installId` for `ipHash`; false when that IP already brought `max` other new IDs today. */
  tryAdd(ipHash: string, installId: string): boolean {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.seen.clear();
    }
    let ids = this.seen.get(ipHash);
    if (!ids) {
      ids = new Set();
      this.seen.set(ipHash, ids);
    }
    if (ids.has(installId)) return true;
    if (ids.size >= this.max) return false;
    ids.add(installId);
    return true;
  }
}

export const newInstallLimiter = new NewInstallLimiter();
