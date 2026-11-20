import { Badge } from "./Badge";

/**
 * The model a container's top row names (the captain's 1C, 2026-09-28): an
 * outline Badge in mono, app-wide - the record card's chrome and a card's
 * head alike. It is never truncated and never pushed out of view: it keeps
 * its width while the flexible neighbor beside it (the key, the meta line)
 * takes `min-width: 0` and the ellipsis. A name longer than the room its
 * row gives it (`maxWidth`, a share of that row) wraps inside the chip
 * rather than being cut or pushing past the row's edge. Not clickable, so
 * no hover state.
 */
export function ModelChip({ label, maxWidth = "100%" }: { label: string; maxWidth?: string }) {
  return (
    <span
      data-model-chip=""
      style={{ display: "inline-flex", flexShrink: 0, minWidth: 0, maxWidth }}
    >
      <Badge
        tone="outline"
        mono
        style={{ maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}
      >
        {label}
      </Badge>
    </span>
  );
}
