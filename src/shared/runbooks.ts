import { z } from "zod";
import { RUNBOOK_WAKES } from "./pullComments";

/**
 * A choice a runbook offers while it is on (docs/runbooks.md, "Built-ins"):
 * batched pull requests are a project's choice only while an enabled runbook
 * offers them. The host never names the runbook that offers; a personal copy
 * keeps the offer.
 */
export const BATCHED_PULL_REQUESTS_OFFER = "batched-pull-requests";

/** Every choice a runbook may offer: the host's closed list. */
export const RUNBOOK_OFFERS = [BATCHED_PULL_REQUESTS_OFFER] as const;
export type RunbookOffer = (typeof RUNBOOK_OFFERS)[number];

/** Only closed facts already carried by a task may select prompt guidance. */
export const runbookMatchSchema = z.strictObject({
  kind: z.array(z.string()).optional(),
  place: z.array(z.enum(["project", "personal"])).optional(),
  delivery: z.array(z.string()).optional(),
  care: z.array(z.string()).optional(),
  backend: z.array(z.string()).optional(),
  project: z.array(z.string()).optional(),
});
export type RunbookFacts = {
  kind: string;
  place: "project" | "personal";
  delivery: string;
  care: string;
  backend: string;
  project?: string;
};
/**
 * A naming runbook's data (docs/runbooks.md, "Built-ins"): the app holds no
 * naming convention of its own, so every name it checks or composes reads
 * the active runbook's.
 */
export const namingRuleSchema = z.strictObject({
  /** A commit subject or a pull request title must match it. */
  pattern: z.string(),
  /** What a refused name's author is told to do instead. */
  message: z.string(),
  /** The name of a commit the app writes itself; `{summary}` stands for its plain summary. */
  compose: z
    .string()
    .regex(/\{summary\}/)
    .optional(),
  /** Each footer of a pull request's own text that its squash commit message carries. */
  footer: z.string().optional(),
});
export type NamingRule = z.infer<typeof namingRuleSchema>;
/** One crew section: a text file, served when the task's facts match its selector. */
export const runbookSectionSchema = z.strictObject({
  file: z.string(),
  when: runbookMatchSchema.optional(),
});
export type RunbookSection = z.infer<typeof runbookSectionSchema>;
export const runbookManifestSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string(),
  author: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  panels: z.array(z.string()).optional(),
  firstmate: z.string().optional(),
  crew: z.union([runbookSectionSchema, z.array(runbookSectionSchema)]).optional(),
  skills: z.string().optional(),
  parts: z.string().optional(),
  projects: z.array(z.string()).optional(),
  replaces: z.string().optional(),
  naming: namingRuleSchema.optional(),
  /** Off until its switch is turned on, for a runbook that ships as an experiment. */
  startsOff: z.literal(true).optional(),
  /**
   * The host's wakes this runbook asks for while it is on, such as new
   * comments on a pull request (`RUNBOOK_WAKES`, docs/runbooks.md "Built-ins").
   */
  wakes: z.array(z.enum(RUNBOOK_WAKES)).optional(),
  /** The choices this runbook offers while it is on (`RUNBOOK_OFFERS`). */
  offers: z.array(z.enum(RUNBOOK_OFFERS)).optional(),
});
export type RunbookManifest = z.infer<typeof runbookManifestSchema>;
export const runbookViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  path: z.string().optional(),
  source: z.enum(["builtin", "installed", "personal"]).optional(),
  error: z.string().optional(),
  /**
   * The panels it shows on the rail while it is on (docs/runbooks.md,
   * "Panels"), each by its panel id and title; absent when it lists none.
   */
  panels: z.array(z.strictObject({ id: z.string(), title: z.string() })).optional(),
});
export type RunbookView = z.infer<typeof runbookViewSchema>;
export const runbookStateSchema = z.record(z.string(), z.boolean());

/**
 * A runbook panel's id (docs/runbooks.md, "Panels"): its runbook's and its
 * folder's names. A runbook that replaces a built-in names it by the
 * built-in's id, so a copy keeps the captain's place for the built-in's panel.
 */
export function runbookPanelId(
  manifest: Pick<RunbookManifest, "id" | "replaces">,
  folder: string,
): string {
  const name =
    folder
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? folder;
  return `${manifest.replaces ?? manifest.id}-${name}`;
}

/**
 * Where a runbook's panel keeps its saved data: its own runbook's id and
 * folder, never the id it shows under, so a panel holding that id, or a copy
 * of the same runbook, never reads or loses another's data. The colon is
 * outside every panel id.
 */
export function runbookPanelSlice(runbookId: string, folder: string): string {
  return `${runbookId}:${folder}`;
}

export function crewSectionsOf(manifest: Pick<RunbookManifest, "crew">): RunbookSection[] {
  if (!manifest.crew) return [];
  return Array.isArray(manifest.crew) ? manifest.crew : [manifest.crew];
}

/** An absent selector is unrestricted; an empty selector deliberately matches nothing. */
export function runbookMatches(
  when: z.infer<typeof runbookMatchSchema> | undefined,
  facts: RunbookFacts,
): boolean {
  return (
    !when ||
    Object.entries(when).every(([key, values]) =>
      (values as readonly string[]).includes(facts[key as keyof RunbookFacts] ?? ""),
    )
  );
}

/** Plain files travel with the session; no path on the home is assumed to exist on a work computer. */
export const runbookSkillFilesSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  files: z.record(z.string(), z.string()),
});
export type RunbookSkillFiles = z.infer<typeof runbookSkillFilesSchema>;
