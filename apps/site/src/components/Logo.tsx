/**
 * nimplex mark: an append-only log. Three committed entries, then a cursor and the next
 * entry, still pending: a session resumes from the last committed step.
 *
 * Geometry lives in a 512-unit square shared with public/favicon.svg, logo-1024.svg and
 * the rendered PNGs. Solid rounded bars stay legible at favicon size. currentColor adapts
 * to the background; the pending entry is the same colour at reduced opacity.
 */
const COMMITTED = [
  { x: 104, y: 96, width: 304, rx: 28 },
  { x: 104, y: 184, width: 200, rx: 28 },
  { x: 104, y: 272, width: 256, rx: 28 },
  { x: 104, y: 360, width: 64, rx: 10 },
];
const PENDING = { x: 192, y: 360, width: 152, rx: 28 };
const BAR_HEIGHT = 56;
const PENDING_OPACITY = 0.4;

/** Square canvas with the icon's margins. */
export const LOGO_SQUARE = "0 0 512 512";
/** Tight bounds of the bars, for the inline lockup. */
export const LOGO_TIGHT = "104 96 304 320";

const HEIGHT = 20;

export function Logo({ square = false }: { square?: boolean }) {
  return (
    <svg
      viewBox={square ? LOGO_SQUARE : LOGO_TIGHT}
      style={
        square
          ? { height: HEIGHT, width: HEIGHT, display: "block" }
          : { height: HEIGHT, width: "auto", display: "block" }
      }
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor">
        {COMMITTED.map((bar) => (
          <rect key={bar.y + bar.x} height={BAR_HEIGHT} {...bar} />
        ))}
        <rect height={BAR_HEIGHT} fillOpacity={PENDING_OPACITY} {...PENDING} />
      </g>
    </svg>
  );
}
