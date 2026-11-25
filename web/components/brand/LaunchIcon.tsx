/**
 * The mark as an icon for launch buttons: the two-line cut drawn for small sizes, in the
 * button's own ink. On hover the arrows part along the slash, each the way it points.
 */
const D =
  "M216.5 -440.0L415.7 -40.0L275.7 -40.0L59.7 -40.0ZM60.1 -41.0L168.1 -41.0L-72.3 440.0L-128.5 440.0ZM168.1 -41.0L276.1 -41.0L87.5 440.0L31.4 440.0Z";

export function LaunchIcon({ size = 16 }: { size?: number }) {
  const half = "col-start-1 row-start-1 overflow-visible fill-current transition-transform duration-200 ease-out motion-reduce:transition-none";
  return (
    <span aria-hidden className="inline-grid shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="-460 -460 920 920" width={size} height={size} className={`${half} opacity-70 group-hover/button:translate-y-[2px] group-hover/button:-translate-x-px`}>
        <path d={D} transform="rotate(180)" />
      </svg>
      <svg viewBox="-460 -460 920 920" width={size} height={size} className={`${half} group-hover/button:-translate-y-[2px] group-hover/button:translate-x-px`}>
        <path d={D} />
      </svg>
    </span>
  );
}
