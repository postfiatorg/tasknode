// Hooded-cloak glyph for the BasedGPT personality. Drawn in-house on the lucide grid
// (24x24, round stroke) so it accepts the same size and strokeWidth props.
export function HoodIcon({ size = 24, strokeWidth = 2, ...props }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M14 2C9.5 2.5 6 6 6 11v3l-3 3v4h18v-4l-3-3v-3c0-3.500-1.500-6.500-4-9z" />
      <path
        fill="currentColor"
        d="M12 8.500c-1.600 0-2.500 1.400-2.500 3.200 0 2 1 3.600 2.500 4.800 1.500-1.200 2.500-2.800 2.500-4.800 0-1.800-.9-3.200-2.500-3.200z"
      />
    </svg>
  );
}
