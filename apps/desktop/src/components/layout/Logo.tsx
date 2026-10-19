import logoUrl from "@/assets/forge-logo.png";

/**
 * FORGE logo (mark and wordmark) for the dark UI. The mark is assets/logo-mark.svg; the PNG is
 * 944 x 184, several times larger than shown, so it stays sharp. Same file as the website's
 * services/stats/src/assets/forge-wordmark.png.
 * `height` sets the size. The app icons come from assets/logo.svg (pnpm tauri icon src/assets/logo.svg).
 */
export function Logo({ height = 40 }: { height?: number }) {
  return <img src={logoUrl} height={height} width={Math.round((height * 944) / 184)} alt="FORGE" draggable={false} className="shrink-0 select-none" />;
}
