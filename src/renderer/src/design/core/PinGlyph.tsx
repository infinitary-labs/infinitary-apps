/**
 * The pin a task's pin control wears (INF-3127): Lucide's pin, outlined on a
 * task that is not pinned and filled on one that is, so the glyph says the
 * state and a press changes it. Drawn in the control's own color.
 */
export function PinGlyph({ pinned, size = 14 }: { pinned: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-pin-glyph={pinned ? "pinned" : "unpinned"}
    >
      <path d="M12 17v5" />
      <path
        d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        fill={pinned ? "currentColor" : "none"}
      />
    </svg>
  );
}
