"use client";

import { useState } from "react";
import { initials } from "./util";

/** A member: the GitHub picture when FORGE sent one, else initials in the member's color (as in FORGE's crew). */
export function MemberAvatar({ name, color, avatar, size = 28, online, label }: { name: string; color: string; avatar?: string | null; size?: number; online?: boolean; label?: string }) {
  const [broken, setBroken] = useState(false);
  const letters = size < 26 ? initials(name).slice(0, 1) : initials(name);
  return (
    <span className="crew-avatar" style={{ width: size, height: size }} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {avatar && !broken ? (
        <img src={avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span className="crew-avatar-letters" style={{ background: color, fontSize: Math.round(size * (letters.length > 1 ? 0.38 : 0.46)) }}>
          {letters}
        </span>
      )}
      {online !== undefined && <span className={online ? "crew-avatar-dot crew-avatar-dot-on" : "crew-avatar-dot"} />}
    </span>
  );
}

const RAYS = [
  [0, 1],
  [27, 0.78],
  [55, 0.92],
  [82, 0.72],
  [110, 0.96],
  [140, 0.8],
  [168, 0.9],
  [196, 0.74],
  [224, 1],
  [252, 0.82],
  [282, 0.94],
  [310, 0.76],
  [336, 0.88],
] as const;

/** Claude's spark, as in FORGE (apps/desktop/src/components/workspace/ClaudeMark.tsx). */
export function ClaudeMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} style={{ width: size, height: size }} viewBox="-50 -50 100 100" aria-label="Claude" role="img" className={className}>
      {RAYS.map(([angle, len]) => (
        <path key={angle} d={`M -4.2 -6 L 0 ${-6 - 40 * len} L 4.2 -6 Z`} transform={`rotate(${angle})`} fill="var(--color-claude)" strokeLinejoin="round" stroke="var(--color-claude)" strokeWidth="2.4" />
      ))}
      <circle r="9" fill="var(--color-claude)" />
    </svg>
  );
}
