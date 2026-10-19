import logoUrl from "@/assets/forge-logo.png";

/**
 * FORGE logo (mark, wordmark, "Claude Development Studio") for the dark UI. The mark is
 * assets/logo-mark.svg; the PNG is 945 x 223, several times larger than shown, so it stays sharp.
 * `height` sets the size. The app icons come from assets/logo.svg (pnpm tauri icon src/assets/logo.svg).
 */
export function Logo({ height = 40 }: { height?: number }) {
  return <img src={logoUrl} height={height} width={Math.round((height * 945) / 223)} alt="FORGE, Claude Development Studio" draggable={false} className="shrink-0 select-none" />;
}
