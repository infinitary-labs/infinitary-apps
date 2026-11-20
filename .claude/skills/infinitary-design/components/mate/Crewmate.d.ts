export interface CrewmateProps {
  /** working = accent color, energetic spin; idle = dim, near-still. Rendered as a 3D tetrahedron — deliberately simpler than the Firstmate. */
  status?: "working" | "idle";
  /** Canvas size in px. Default 28. Crewmates stay small — never a focal point. */
  size?: number;
  style?: React.CSSProperties;
}
