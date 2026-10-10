/** Claude spark: tapered rays around a center, in Claude's terracotta (token --color-claude). */
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

export function ClaudeMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-50 -50 100 100" aria-label="Claude" role="img">
      {RAYS.map(([angle, len]) => (
        <path
          key={angle}
          d={`M -4.2 -6 L 0 ${-6 - 40 * len} L 4.2 -6 Z`}
          transform={`rotate(${angle})`}
          fill="var(--color-claude)"
          strokeLinejoin="round"
          stroke="var(--color-claude)"
          strokeWidth="2.4"
        />
      ))}
      <circle r="9" fill="var(--color-claude)" />
    </svg>
  );
}
