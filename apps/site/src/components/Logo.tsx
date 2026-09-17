import { useId } from "react";

/**
 * nimplex mark: three input paths merge into one output.
 *
 * Constant stroke width (76 in a 1024-unit viewBox) preserves small-size legibility.
 * The earlier thin-to-thick design lost its narrow ends when reduced;
 *
 * Square geometry supports app icons/avatars. The site lockup tightly crops
 * the same paths so both uses share one maintained shape.
 *
 * Inputs are darkest and the merged output brightest; currentColor adapts to backgrounds.
 */
/**
 * Curved upper/lower inputs, straight middle input, and output share one path.
 * Separate translucent paths would composite at intersections into bright spots;
 * self-overlap within a single element paints only once.
 */
export const LOGO_PATH =
  "M168 232C380 232 400 470 556 512M168 512H856M168 792C380 792 400 554 556 512";

export const LOGO_STROKE = 76;
/** Square canvas with symmetric margins including round caps. */
export const LOGO_SQUARE = "0 0 1024 1024";
/** Tight bounds including round caps. */
export const LOGO_TIGHT = "130 194 764 636";

const HEIGHT = 20;

export function Logo({ square = false }: { square?: boolean }) {
  const id = useId().replace(/:/g, "");
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
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="168" y1="0" x2="856" y2="0">
          <stop offset="0" stopColor="currentColor" stopOpacity=".38" />
          <stop offset=".6" stopColor="currentColor" stopOpacity=".82" />
          <stop offset="1" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth={LOGO_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={LOGO_PATH} />
      </g>
    </svg>
  );
}
