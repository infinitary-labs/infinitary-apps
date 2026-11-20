export interface KeyCapProps {
  /** Key label: "⌥", "⌘", "space", "K". Use real keyboard glyphs. */
  children?: React.ReactNode;
  size?: "sm" | "md";
  /** The one key pressed and waiting: accent fill and border. */
  lit?: boolean;
}
