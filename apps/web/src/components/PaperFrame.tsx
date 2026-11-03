/**
 * 全屏纸纹与四角花角。放在应用最外层，只做视觉装饰，不参与布局与交互。
 */
export function PaperFrame() {
  return (
    <div aria-hidden="true" className="paper-frame">
      <svg aria-hidden="true" className="paper-grain">
        <filter id="fathom-paper-grain">
          <feTurbulence
            baseFrequency="0.82"
            numOctaves="4"
            stitchTiles="stitch"
            type="fractalNoise"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect filter="url(#fathom-paper-grain)" height="100%" opacity="0.03" width="100%" />
      </svg>
      {(["tl", "tr", "bl", "br"] as const).map((corner) => (
        <svg
          aria-hidden="true"
          className={`paper-corner paper-corner-${corner}`}
          key={corner}
          viewBox="0 0 64 64"
        >
          <path d="M4 60V22C4 12 12 4 22 4h38" />
          <path d="M11 52V24c0-7 6-13 13-13h28" />
          <path d="M20 42c0-9 7-16 16-16 4 0 8 2 10 5" />
          <path d="M20 42c4-4 9-6 14-6" />
        </svg>
      ))}
    </div>
  );
}
