/** Words shared by the independent correction offer and its product journeys. */
export const CORRECTION_OFFER_WORDS = {
  title: "Keep this for future work?",
  keep: "Keep for this project",
  decline: "Just this time",
} as const;

export function keptProjectDirection(project: string, text: string): string {
  return `Kept for ${project}: ${text}`;
}
