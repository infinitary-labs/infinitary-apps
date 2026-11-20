/**
 * @startingPoint section="Character" subtitle="The 4D tesseract character; animation reflects state" viewport="700x320"
 */
export interface FirstmateProps {
  /** idle = near-still 4D drift; listening = shapeshifts flat into counter-rotating concentric hexagons + inner square (pass level 0–1); working = fast double rotation + shimmer + pulsing nodes. Transitions are continuous morphs. "thinking" is a legacy alias of working. */
  state?: "idle" | "listening" | "working" | "thinking";
  /** Canvas size in px. Null state ≈ 280–320; docked ≈ 56–72. */
  size?: number;
  /** 0–1 live voice level; scales the structure and accelerates the hexagon spin while listening. */
  level?: number;
  /** Monotonic counter; each increment (e.g. per keystroke) kicks the listening spin, which decays smoothly back to base velocity. */
  kick?: number;
  style?: React.CSSProperties;
}
