import { z } from "zod";
import { HERE } from "./deviceNames";
import { AUTOMATIC_COMPUTER } from "./placement";
import {
  projectJoinSchema,
  projectKeyChoiceSchema,
  type RepoView,
  repoDeliverySchema,
  repoSetupSpecSchema,
} from "./repos";
import { rigorSchema } from "./rigor";
import { devicePlace } from "./signIns";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  PROJECT_DELIVERY_WORDS,
  RIGOR_WORDS,
} from "./vocabulary";

/**
 * The setup card (docs/fleet.md, "Asking the first mate to add a project";
 * design skill `components/projects/SetupCard`): Firstmate proposes a
 * project at any time, the app checks the request without changing
 * anything and writes the card from what it checked, and only the
 * captain's click on its Add project adds it, with the settings he chose
 * there. Settings' own Add project adds at once and never shows it.
 */

/** What Firstmate may suggest; the card starts at these, or at today's defaults. */
const suggestions = {
  delivery: repoDeliverySchema.optional(),
  autonomy: z.boolean().optional(),
  rigor: rigorSchema.optional(),
  /** Automatic, a computer that runs work by its deviceId, or null for this computer. */
  runsOn: z.string().min(1).max(64).nullable().optional(),
  /** The work Firstmate starts once the project is added, in a few words. */
  work: z.string().trim().min(1).max(240).optional(),
};

/**
 * `app_change project-setup`'s value: the project, the task key the captain
 * chose for it (the setup spec's own `key`), and what Firstmate suggests.
 */
export const projectSetupProposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("clone"),
    origin: z.string().trim().min(1),
    name: z.string().optional(),
    key: projectKeyChoiceSchema.optional(),
    project: projectJoinSchema.optional(),
    ...suggestions,
  }),
  z.strictObject({
    kind: z.literal("init"),
    name: z.string().trim().min(1),
    key: projectKeyChoiceSchema.optional(),
    project: projectJoinSchema.optional(),
    ...suggestions,
  }),
  z.strictObject({
    kind: z.literal("adopt"),
    path: z.string().trim().min(1),
    name: z.string().optional(),
    key: projectKeyChoiceSchema.optional(),
    project: projectJoinSchema.optional(),
    ...suggestions,
  }),
]);
export type ProjectSetupProposal = z.infer<typeof projectSetupProposalSchema>;

/**
 * What the card's Add project does, carried on its own host effect: the
 * setup it runs, the clone it runs instead when the captain picks one, and
 * what the card showed selected, which an answer that did not arrive keeps.
 */
export const projectSetupOfferSchema = z.strictObject({
  name: z.string().min(1),
  setup: repoSetupSpecSchema,
  clone: repoSetupSpecSchema.optional(),
  proposed: z.strictObject({
    delivery: repoDeliverySchema,
    autonomy: z.boolean(),
    rigor: rigorSchema,
    runsOn: z.string().min(1).max(64).nullable(),
  }),
  work: z.string().optional(),
  /**
   * The captain dropped the folder on the main message box (docs/composer.md,
   * "Files"): the first mate never asked, so it hears nothing of the answer.
   */
  dropped: z.literal(true).optional(),
});
export type ProjectSetupOffer = z.infer<typeof projectSetupOfferSchema>;

/** The names of the card's questions, as its answers carry them. */
export const SETUP_CARD_FIELDS = {
  landing: "landing",
  runsOn: "runs_on",
  delivery: "delivery",
  autonomy: "autonomy",
  care: "care",
} as const;

/** The card's words. */
export const SETUP_CARD_WORDS = {
  title: (name: string) => `Add ${name} as a project?`,
  /** A repository joining an existing project (INF-4220). */
  titleInto: (name: string, project: string) => `Add ${name} to ${project}?`,
  add: "Add project",
  addInto: "Add repository",
  notNow: "Not now",
  landing: `How it lands on ${HERE.this}`,
  link: "Link the folder where it is",
  clone: "Clone a fresh copy into your projects folder",
  runsOn: "Runs on",
  delivery: "Where changes go",
  autonomy: AUTONOMY_SWITCH_NAME,
  care: "Rigor",
  /** The fact naming the task key Firstmate asked for, when it named one. */
  key: "Task key",
  /** The fact naming the project a repository joins, and its key. */
  project: "Project",
  projectFact: (name: string, key: string) => `${name} · ${key}`,
} as const;

/** How the captain answered a setup card, as Firstmate hears it once. */
export type ProjectSetupOutcome = "added" | "already" | "not-now" | "failed";

/** The settings a project was added with, as the Firstmate hears them. */
export function setupSettingsWords(
  repo: RepoView,
  devices: Parameters<typeof devicePlace>[0],
): string {
  const where = repo.runsOn ? devicePlace(devices, repo.runsOn).where : `on ${HERE.this}`;
  return [
    `changes go as ${PROJECT_DELIVERY_WORDS[repo.delivery]} (${repo.delivery})`,
    repo.autonomy
      ? `${AUTONOMY_WORDS.putsInItself.toLowerCase()} (autonomy on)`
      : `${AUTONOMY_WORDS.asksFirst.toLowerCase()} (autonomy off)`,
    `${RIGOR_WORDS[repo.rigor ?? "standard"]} rigor (${repo.rigor ?? "standard"})`,
    repo.runsOn === AUTOMATIC_COMPUTER ? "chooses a computer for each new task" : `runs ${where}`,
  ].join(", ");
}
