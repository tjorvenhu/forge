import logoUrl from "@/assets/forge-logo.png";

/**
 * FORGE logo (symbol, wordmark, "Claude Development Studio") from the branding kit, recolored for the
 * dark UI: the charcoal parts are light, the orange stays. Source FORGE_Logo_Horizontal_White_BG.png,
 * 1055 x 223, several times larger than shown, so it stays sharp. `height` sets the size.
 * The app icons come from assets/logo.svg (pnpm tauri icon src/assets/logo.svg).
 */
export function Logo({ height = 40 }: { height?: number }) {
  return <img src={logoUrl} height={height} width={Math.round((height * 1055) / 223)} alt="FORGE, Claude Development Studio" draggable={false} className="shrink-0 select-none" />;
}
