import { useId } from "react";

/**
 * nimplex 的標記：三股匯成一股。
 *
 * 線寬全程固定（1024 座標系下 76），不做粗細變化 —— 之前那版從髮絲漲到粗桿，
 * 落差太大、縮到小尺寸時細端會先消失。統一線寬在 16px 也還是同一個形狀。
 *
 * 幾何以 1024×1024 正方形為準（app icon / avatar 用），站上的 lockup 用同一組
 * 路徑的緊裁視窗，所以兩者永遠是同一個東西，不是兩份各自維護的檔案。
 *
 * 漸層方向有意義：輸入端最暗、匯流後最亮。用 currentColor，深底白、淺底黑。
 */
/**
 * 三股輸入（上下走曲線、中間直進）與匯流後的輸出，全部在同一個 d 裡。
 * 不可以拆成多個 <path>：不同元素的半透明描邊會在交會處互相合成，疊出一個亮點。
 * 同一元素內的自我重疊只算一次。
 */
export const LOGO_PATH =
  "M168 232C380 232 400 470 556 512M168 512H856M168 792C380 792 400 554 556 512";

export const LOGO_STROKE = 76;
/** 正方形畫布（含 round cap 後上下左右留白對稱） */
export const LOGO_SQUARE = "0 0 1024 1024";
/** 緊裁視窗：把 round cap 也算進去的實際外框 */
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
