import { z } from "zod";

/** Project identity and audience, read from a description host independently of native uploads. */
export const hostedPresentationDestinationSchema = z.strictObject({
  host: z.string().min(1),
  projectId: z.number().int().positive().safe(),
  fullName: z.string().min(1),
  visibility: z.enum(["public", "private", "internal"]),
  /** Older saved stories named only the two public hosts. */
  format: z.enum(["github", "gitlab"]).optional(),
  /** Contributions publish text when fork-upload visibility has not been established. */
  media: z.literal("card-only").optional(),
});
export type HostedPresentationDestination = z.infer<typeof hostedPresentationDestinationSchema>;

/** No description or upload receipt is invented for a branch or a local project. */
export const localPresentationDestinationSchema = z.strictObject({
  kind: z.literal("local"),
  project: z.string().min(1),
});
export type LocalPresentationDestination = z.infer<typeof localPresentationDestinationSchema>;

export const presentationDestinationSchema = z.union([
  hostedPresentationDestinationSchema.refine(
    (destination) =>
      destination.format !== undefined ||
      destination.host === "github.com" ||
      destination.host === "gitlab.com",
    "A description on another host must name its format.",
  ),
  z.strictObject({ kind: z.literal("branch"), origin: z.string().min(1) }),
  localPresentationDestinationSchema,
]);
export type PresentationDestination = z.infer<typeof presentationDestinationSchema>;

export function hostedPresentation(
  destination: PresentationDestination,
): destination is HostedPresentationDestination {
  return "host" in destination;
}

export function presentationFormat(
  destination: HostedPresentationDestination,
): "github" | "gitlab" {
  return destination.format ?? (destination.host === "gitlab.com" ? "gitlab" : "github");
}

/** The two supported native routes. An unavailable or failed route never becomes text-only. */
export function nativePresentationMedia(destination: PresentationDestination): boolean {
  return (
    hostedPresentation(destination) &&
    destination.media !== "card-only" &&
    ((destination.host === "github.com" && presentationFormat(destination) === "github") ||
      (destination.host === "gitlab.com" && presentationFormat(destination) === "gitlab"))
  );
}

export function samePresentationDestination(
  left: PresentationDestination,
  right: PresentationDestination,
): boolean {
  if (hostedPresentation(left)) {
    return (
      hostedPresentation(right) &&
      left.host === right.host &&
      left.projectId === right.projectId &&
      left.fullName === right.fullName &&
      left.visibility === right.visibility &&
      left.media === right.media &&
      presentationFormat(left) === presentationFormat(right)
    );
  }
  if (hostedPresentation(right) || left.kind !== right.kind) return false;
  return left.kind === "local" && right.kind === "local"
    ? left.project === right.project
    : left.kind === "branch" && right.kind === "branch" && left.origin === right.origin;
}
