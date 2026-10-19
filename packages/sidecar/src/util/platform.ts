/** Platforms FORGE ships for; the tag is part of release asset names and of the runtime key. */
export type PlatformTag = "win32-x64" | "darwin-arm64" | "darwin-x64" | "linux-x64";

/**
 * How this FORGE was installed, passed by the desktop shell in FORGE_INSTALL_KIND: nsis (Windows
 * installer), app (macOS .app), appimage (Linux AppImage), system (a Linux package such as .deb, updated
 * by the package manager), dev (debug build).
 */
export type InstallKind = "nsis" | "app" | "appimage" | "system" | "dev";

const INSTALL_KINDS: readonly InstallKind[] = ["nsis", "app", "appimage", "system", "dev"];

/**
 * Tag of the running platform. FORGE_PLATFORM from the desktop shell wins; Windows is always win32-x64
 * (the only Windows build). Other unknown combinations fall back to the nearest shipped tag.
 */
export function platformTag(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformTag {
  const given = env.FORGE_PLATFORM;
  if (given === "win32-x64" || given === "darwin-arm64" || given === "darwin-x64" || given === "linux-x64") return given;
  if (platform === "win32") return "win32-x64";
  if (platform === "darwin") return arch === "x64" ? "darwin-x64" : "darwin-arm64";
  return "linux-x64";
}

/** FORGE_INSTALL_KIND, null when the shell did not pass one (older Windows shells: behave as before). */
export function installKind(env: NodeJS.ProcessEnv = process.env): InstallKind | null {
  const k = env.FORGE_INSTALL_KIND;
  return k && (INSTALL_KINDS as readonly string[]).includes(k) ? (k as InstallKind) : null;
}

export const isWindows = (platform: NodeJS.Platform = process.platform) => platform === "win32";
