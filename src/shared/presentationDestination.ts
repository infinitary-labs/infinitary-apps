import { z } from "zod";
import { forgeOf } from "./forge";
import {
  CHANGE_REQUEST_HOSTS,
  CHANGE_REQUEST_KINDS,
  type ChangeRequestKind,
  changeRequestHostAt,
} from "./forgeKinds";

/** Project identity and audience, read from a description host independently of native uploads. */
export const hostedPresentationDestinationSchema = z.strictObject({
  host: z.string().min(1),
  projectId: z.number().int().positive().safe(),
  fullName: z.string().min(1),
  visibility: z.enum(["public", "private", "internal"]),
  /** Older saved stories named only the two public hosts. */
  format: z.enum(CHANGE_REQUEST_KINDS).optional(),
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
      destination.format !== undefined || changeRequestHostAt(destination.host) !== undefined,
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

export function presentationFormat(destination: HostedPresentationDestination): ChangeRequestKind {
  return destination.format ?? changeRequestHostAt(destination.host)?.kind ?? "github";
}

/** Each kind's native route, on its own public host only. An unavailable or failed route never becomes text-only. */
export function nativePresentationMedia(destination: PresentationDestination): boolean {
  return (
    hostedPresentation(destination) &&
    destination.media !== "card-only" &&
    destination.host === CHANGE_REQUEST_HOSTS[presentationFormat(destination)].publicHost
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

/** Match a saved destination to an approved Git address, not to its audience. */
export function storyAtOrigin(
  destination: PresentationDestination,
  origin: string | null,
): boolean {
  if (!hostedPresentation(destination))
    return destination.kind === "branch" && destination.origin === origin;
  const where = forgeOf(origin);
  if (where.host !== destination.host || !where.owner || !where.name) return false;
  const name = `${where.owner}/${where.name}`;
  return presentationFormat(destination) === "github"
    ? destination.fullName.toLowerCase() === name.toLowerCase()
    : destination.fullName === name;
}
