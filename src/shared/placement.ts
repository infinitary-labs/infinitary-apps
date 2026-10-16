import { z } from "zod";
import { deviceChipSchema } from "./devices";
import { computerResourceReadingSchema } from "./resources";
import { computerSignInsSchema } from "./signIns";

/** Work platforms only; a paired phone or an unsupported OS is not a worker. */
export const placementSystemSchema = z.enum(["macos", "linux"]);
export type PlacementSystem = z.infer<typeof placementSystemSchema>;
export const placementProfileSchema = z.enum(["conversation", "standard", "heavy"]);
export type PlacementProfile = z.infer<typeof placementProfileSchema>;

/**
 * Explicit project requirements and task refinements, never inferred from text.
 * Omitted platform fields inherit the home platform, not universal portability.
 * A task narrows declared platforms and adds tools; it cannot waive project needs.
 */
export const placementRequirementsSchema = z.strictObject({
  systems: z.array(placementSystemSchema).min(1).max(2).optional(),
  chips: z.array(deviceChipSchema).min(1).max(2).optional(),
  tools: z
    .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/))
    .max(32)
    .optional(),
  profile: placementProfileSchema.optional(),
});
export type PlacementRequirements = z.infer<typeof placementRequirementsSchema>;

/** Advisory admission budget, not an enforced process limit or measured prediction. */
export type PlacementDemand = { cpu: number; memoryBytes: number };
const GIB = 1024 ** 3;
export const PLACEMENT_DEMANDS: Readonly<Record<PlacementProfile, Readonly<PlacementDemand>>> = {
  conversation: { cpu: 0.25, memoryBytes: GIB / 2 },
  standard: { cpu: 0.5, memoryBytes: 2 * GIB },
  heavy: { cpu: 2, memoryBytes: 4 * GIB },
};

export type PlacementFact = "available" | "unavailable" | "unknown";
export const placementRejectionSchema = z.enum([
  "requirements-invalid",
  "out-of-reach",
  "older-firstmate",
  "work-disabled",
  "bound-elsewhere",
  "platform-unknown",
  "system-incompatible",
  "chip-incompatible",
  "tool-unknown",
  "tool-unavailable",
  "project-unknown",
  "project-unavailable",
  "model-unknown",
  "model-unavailable",
  "model-floor",
  "physical-computer-unknown",
  "resources-unknown",
  "resources-stale",
  "resources-invalid",
  "reservations-invalid",
  "memory-unavailable",
  "cpu-busy",
  "memory-busy",
  "model-preferred-elsewhere",
]);
export type PlacementRejection = z.infer<typeof placementRejectionSchema>;

export const AUTOMATIC_COMPUTER = "automatic";
export const AUTOMATIC_WORD = "Automatic";
export const PLACEMENT_FACTS_ORDER = "inf:computer:placement";
export const PLACEMENT_FACTS_SINCE = "8.0.0";
export const PLACEMENT_FACT_MAX_AGE_MS = 10_000;

const factSchema = z.enum(["available", "unavailable", "unknown"]);
// Project and task can each name 32 different programs, plus the implicit Git requirement.
const RESOLVED_TOOL_LIMIT = 65;
export const placementFactsRequestSchema = z.strictObject({
  tools: z.array(placementRequirementsSchema.shape.tools.unwrap().element).max(RESOLVED_TOOL_LIMIT),
  /** The exact project's origin, stripped of embedded sign-in material. */
  origin: z.string().min(1).max(4096).optional(),
});
export type PlacementFactsRequest = z.infer<typeof placementFactsRequestSchema>;
export const placementFactsSchema = z.object({
  system: placementSystemSchema.optional(),
  chip: deviceChipSchema.optional(),
  /**
   * Hash of the system identity of the computer its readings measure, a virtual
   * machine's own, common to every user; unknown fails closed.
   */
  physicalComputerId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  tools: z.record(z.string(), factSchema),
  projectAccess: factSchema,
});
export type PlacementFacts = z.infer<typeof placementFactsSchema>;
export const placementFactsAnswerSchema = placementFactsSchema.extend({
  /** Actual identities served by this computer's own accounts, never the home's catalog. */
  signIns: computerSignInsSchema.nullable(),
});

const demandSchema = z.object({
  cpu: z.number().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
});
const modelSchema = z.object({ provider: z.string().max(256), id: z.string().max(256) });
/** One bounded historical explanation, saved at commitment, never read as fresh capacity. */
export const placementSnapshotSchema = z.object({
  version: z.literal(1),
  at: z.number(),
  computerId: z.string().nullable(),
  computerName: z.string().max(256),
  physicalComputerId: z.string().regex(/^[a-f0-9]{64}$/),
  orderId: z.string().min(1).max(128),
  origin: z.string().max(4096).optional(),
  demand: demandSchema,
  model: modelSchema,
  acceptedFallback: z.boolean(),
  requirements: placementRequirementsSchema.extend({
    tools: z
      .array(placementRequirementsSchema.shape.tools.unwrap().element)
      .max(RESOLVED_TOOL_LIMIT),
  }),
  candidateCount: z.number().int().positive(),
  candidates: z
    .array(
      z.object({
        computerId: z.string().nullable(),
        name: z.string().max(256),
        physicalComputerId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        rejections: z.array(placementRejectionSchema).max(32),
        missingTools: z.array(z.string().max(80)).max(RESOLVED_TOOL_LIMIT),
        reading: computerResourceReadingSchema,
        factsAgeMs: z.number().nonnegative().nullable(),
        capacity: demandSchema.nullable(),
        reserved: demandSchema,
        remaining: demandSchema.nullable(),
        model: modelSchema.nullable(),
        preferenceRank: z.number().nonnegative().nullable(),
      }),
    )
    .max(64),
});
export type PlacementSnapshot = z.infer<typeof placementSnapshotSchema>;
export const committedPlacementSchema = z.object({
  snapshot: placementSnapshotSchema,
  /** Pending until a proven end, or a later observation includes running demand. */
  reservation: z.enum(["pending", "observed", "ended"]),
  /** Written before asynchronous preparation, so closing an unsent start is provably safe. */
  preparationStarted: z.boolean().optional(),
});
export type CommittedPlacement = z.infer<typeof committedPlacementSchema>;

export function placementReason(snapshot: Pick<PlacementSnapshot, "computerName">): string {
  return `Automatic chose ${snapshot.computerName}: it can run this project and had room to start.`;
}
export const PLACEMENT_WAIT =
  "Waiting for a compatible computer with room to start. Existing work stays where it started.";
export const PLACEMENT_MODEL_WAIT =
  "Waiting for a computer with a model that can take this task. Existing work stays where it started.";

const ROOM_REJECTIONS: readonly PlacementRejection[] = [
  "cpu-busy",
  "memory-busy",
  "model-preferred-elsewhere",
];
const MODEL_REJECTIONS: readonly PlacementRejection[] = ["model-unavailable", "model-floor"];
const FLOOR_REJECTIONS: readonly PlacementRejection[] = ["model-floor"];

/** Whether some computer was refused for these reasons alone. */
function onlyFor(
  rejections: readonly (readonly PlacementRejection[])[],
  reasons: readonly PlacementRejection[],
): boolean {
  return rejections.some(
    (row) => row.length > 0 && row.every((reason) => reasons.includes(reason)),
  );
}

/**
 * Why an Automatic start waits, from each computer's typed rejections: the
 * model when a computer that could otherwise take the task was refused only
 * for its model and none waits only for room; room otherwise.
 */
export function placementWait(rejections: readonly (readonly PlacementRejection[])[]): string {
  return onlyFor(rejections, MODEL_REJECTIONS) && !onlyFor(rejections, ROOM_REJECTIONS)
    ? PLACEMENT_MODEL_WAIT
    : PLACEMENT_WAIT;
}

/**
 * Whether an Automatic start waits for the level its task asked for, a
 * premium ask or an escalation's rung: a computer that could otherwise take
 * it was refused only for that level, and none waits only for room. Such a
 * wait is held on that level's reset, as a This computer start is.
 */
export function placementFloorHold(
  rejections: readonly (readonly PlacementRejection[])[],
): boolean {
  return onlyFor(rejections, FLOOR_REJECTIONS) && !onlyFor(rejections, ROOM_REJECTIONS);
}

const REJECTION_WORDS: Record<PlacementRejection, string> = {
  "requirements-invalid": "requirements could not be resolved",
  "out-of-reach": "out of reach",
  "older-firstmate": "has an older Infinitary",
  "work-disabled": "not taking work",
  "bound-elsewhere": "the task stays on its chosen computer",
  "platform-unknown": "system or architecture unknown",
  "system-incompatible": "different required system",
  "chip-incompatible": "different required architecture",
  "tool-unavailable": "a required program was missing",
  "tool-unknown": "a required program could not be checked",
  "project-unavailable": "project unavailable",
  "project-unknown": "project access could not be checked",
  "model-unknown": "available models unknown",
  "model-unavailable": "no suitable model available",
  "model-floor": "waiting for the requested level",
  "physical-computer-unknown": "physical computer could not be identified",
  "resources-stale": "resource reading was too old",
  "resources-unknown": "resources could not be checked",
  "resources-invalid": "resource reading was invalid",
  "memory-unavailable": "available memory unknown",
  "reservations-invalid": "pending work could not be checked",
  "model-preferred-elsewhere": "another computer better met the requested model or level",
  "cpu-busy": "not enough spare processing capacity",
  "memory-busy": "not enough spare memory",
};

/** Past-tense explanations: these readings describe the commitment, never now. */
export function placementCandidateLines(snapshot: PlacementSnapshot): string[] {
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return [
    ...snapshot.candidates.map((candidate) => {
      const verdict =
        candidate.computerId === snapshot.computerId
          ? "chosen"
          : candidate.rejections.map((reason) => REJECTION_WORDS[reason]).join("; ") ||
            "compatible, with less room to start";
      const capacity = candidate.remaining
        ? ` After pending work: ${candidate.remaining.cpu.toFixed(1)} CPUs and ${gib(candidate.remaining.memoryBytes)} GiB memory available.`
        : "";
      const age =
        candidate.reading.status === "fresh"
          ? ` Reading age: ${(candidate.reading.ageMs / 1000).toFixed(1)} seconds.`
          : "";
      return `${candidate.name}: ${verdict}.${capacity}${age}`;
    }),
    ...(snapshot.candidateCount > snapshot.candidates.length
      ? [
          `${snapshot.candidateCount - snapshot.candidates.length} other computers are outside this saved summary.`,
        ]
      : []),
  ];
}
