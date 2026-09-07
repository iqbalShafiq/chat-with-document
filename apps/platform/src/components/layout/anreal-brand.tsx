type BrandProps = {
  className?: string;
};

/** Geist Sans Bold lowercase-a monogram. */
export function AnrealMark({ className = "" }: BrandProps) {
  return (
    <span
      className={`anreal-mark inline-flex size-8 shrink-0 items-center justify-center rounded-xl ${className}`}
    >
      <svg
        role="img"
        aria-label="anreal monogram"
        viewBox="0 0 594 594"
        className="size-[1.15rem]"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g transform="translate(0 566) scale(1 -1)">
          <path d="M225.4 -12Q141.6 -12 89.2 26.6Q36.8 65.2 36.8 134.4Q36.8 204.8 81.3 243.5Q125.8 282.2 213.4 300L385.8 334.4Q385.8 386.4 362.4 412.8Q339 439.2 294.6 439.2Q252.2 439.2 228.3 419.5Q204.4 399.8 196.6 362.2L45.8 368.6Q61.4 457.4 125.8 502.7Q190.2 548 294.6 548Q414.6 548 475.2 490.8Q535.8 433.6 535.8 323.6V141.2Q535.8 118.4 543.5 110.6Q551.2 102.8 566.2 102.8H581.2V0Q574.2 -2.2 558.6 -3.9Q543 -5.6 527.6 -5.6Q495.8 -5.6 468.2 5Q440.6 15.6 424 42.5Q407.4 69.4 407.4 118.4L419.8 108Q410.4 72.2 384.6 45Q358.8 17.8 318.5 2.9Q278.2 -12 225.4 -12ZM261 90.8Q298.4 90.8 326.3 105.6Q354.2 120.4 370 148.1Q385.8 175.8 385.8 214.4V240.4L264.2 214.4Q227.6 206.8 209.5 190.5Q191.4 174.2 191.4 148.4Q191.4 121 209.2 105.9Q227 90.8 261 90.8Z" />
        </g>
      </svg>
    </span>
  );
}

export function AnrealWordmark({ className = "" }: BrandProps) {
  return (
    <span
      aria-label="anreal"
      className={`anreal-wordmark inline-flex items-baseline text-sm font-semibold lowercase text-text ${className}`}
    >
      <span aria-hidden>anreal</span>
    </span>
  );
}

export function AnrealBrand({ className = "" }: BrandProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <AnrealMark />
      <AnrealWordmark className="truncate" />
    </span>
  );
}
