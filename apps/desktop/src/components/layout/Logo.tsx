import logoUrl from "@/assets/logo.png";

/** FORGE mark: anvil with spark on its dark tile (assets/logo.png, also the app icon source). */
export function Logo({ size = 40 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden draggable={false} className="shrink-0 select-none rounded-lg" />;
}
