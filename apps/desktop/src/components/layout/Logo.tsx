import logoUrl from "@/assets/logo-dark.svg";

/** FORGE mark (anvil with sparks), variant with lighter metal for dark surfaces. Original: assets/logo.svg. */
export function Logo({ size = 40 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden draggable={false} className="shrink-0 select-none" />;
}
