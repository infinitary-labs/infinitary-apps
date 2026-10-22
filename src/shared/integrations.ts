import { z } from "zod";
import { forgeSignInStateSchema } from "./forges";

/**
 * Integrations (docs/integrations.md): a connection to something outside
 * the person's projects that the first mate and every crewmate can reach,
 * signed in as the person. One record per connection, declared by its kind
 * as facets: what it can do (actions, each marked with what it does to the
 * world), and who it is signed in as. The core holds the record
 * (`src/core/integrations/`); this file is the wire shape Settings ->
 * Integrations draws and the first mate reads.
 *
 * Nothing here carries a secret: a kind's sign-in stays with its own owner
 * (GitHub's with the forge's 0600 store, `docs/forge.md`), and a slot a
 * kind declares is shown only as kept or not (`docs/integrations.md`,
 * "Keys"). The one request that carries a value is
 * `inf:integrations:secret`, and nothing hands it back.
 */

/**
 * The kinds the app can connect: GitHub, and any MCP server the person
 * adds (each its own row). A new kind is one more binding. `stand-in` is
 * a development or end-to-end run's stand-in that tells events from a
 * folder (`INFINITARY_STAND_IN_INTEGRATION`), never connected in a
 * packaged build.
 */
export const integrationKindSchema = z.enum(["github", "mcp", "stand-in"]);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

/** What each kind is called on screen. */
export const INTEGRATION_KIND_NAMES: Record<IntegrationKind, string> = {
  github: "GitHub",
  mcp: "MCP server",
  "stand-in": "Stand-in",
};

/**
 * What an action does to the world, as the kind's binding declares it,
 * never read off its name: `reads` changes nothing, `changes` alters
 * something there, `sends` reaches other people.
 */
export const integrationEffectSchema = z.enum(["reads", "changes", "sends"]);
export type IntegrationEffect = z.infer<typeof integrationEffectSchema>;

/**
 * Who decides when an action runs: `allow` runs it, `ask` waits for the
 * captain's click on a card, `never` refuses it. Until the secret
 * manager's rules land, a read is allowed and anything that changes or
 * sends asks (the captain's answer on INF-775); an action turned off is never.
 */
export const integrationRuleSchema = z.enum(["allow", "ask", "never"]);
export type IntegrationRule = z.infer<typeof integrationRuleSchema>;

/** The rule an action follows, from its effect and whether it is on. */
export function integrationRule(effect: IntegrationEffect, enabled: boolean): IntegrationRule {
  if (!enabled) return "never";
  return effect === "reads" ? "allow" : "ask";
}

/** An action's name: lowercase words joined by underscores. */
export const integrationActionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "an action is named in lowercase words joined by underscores");

export const integrationActionViewSchema = z
  .object({
    name: integrationActionNameSchema,
    /** The action in a few plain words ("Read from GitHub"). */
    label: z.string().min(1).max(64),
    effect: integrationEffectSchema,
    enabled: z.boolean(),
    rule: integrationRuleSchema,
  })
  .strict();
export type IntegrationActionView = z.infer<typeof integrationActionViewSchema>;

/**
 * Something an integration can tell (docs/integrations.md, "What an integration can tell"): an
 * event a rule may listen to, looked for every `every` minutes.
 */
export const integrationEventViewSchema = z
  .object({
    name: integrationActionNameSchema,
    /** The event in a few plain words ("The count changed"). */
    label: z.string().min(1).max(64),
    /** How often, in minutes, a listening rule looks for it. */
    every: z.number().int().min(1),
  })
  .strict();
export type IntegrationEventView = z.infer<typeof integrationEventViewSchema>;

/** An integration's id: lowercase words joined by dashes ("github", "mcp-linear"). */
export const integrationIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, "an integration is named by its id");

/**
 * The most actions one row holds: an MCP server that lists more is refused
 * in words when it is added, and keeps its first ones if its list grows.
 */
export const INTEGRATION_ACTIONS_MAX = 256;

/**
 * A secret slot's name, as its kind declares it: a word or an environment
 * variable's name ("api_key", "LINEAR_API_KEY").
 */
export const integrationSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "a key is named in letters, digits and underscores");

/** A slot as Settings draws it: its name, its words, and whether a value is kept. Never the value. */
export const integrationSecretViewSchema = z
  .object({
    name: integrationSecretNameSchema,
    /** A few plain words for the slot ("Linear key"). */
    label: z.string().min(1).max(64),
    /** A value is kept for it. */
    kept: z.boolean(),
    /** Its actions run without it. */
    optional: z.boolean().optional(),
  })
  .strict();
export type IntegrationSecretView = z.infer<typeof integrationSecretViewSchema>;

/** A value the captain enters for a slot, once; nothing hands it back. */
export const integrationSecretValueSchema = z
  .string()
  .min(1)
  .max(16 * 1024);

export const integrationViewSchema = z
  .object({
    id: integrationIdSchema,
    kind: integrationKindSchema,
    /** The person's word for it; the kind's name until renamed. */
    name: z.string().min(1).max(64),
    /** Who it is signed in as there; null until it has answered once. */
    account: z.string().max(100).nullable(),
    /** The sign-in's health, through the five rules (`docs/quota.md`). */
    health: forgeSignInStateSchema,
    /** Paused: nobody reaches it until it is resumed. */
    paused: z.boolean(),
    /**
     * What an MCP server's row runs: the program and its arguments, or its
     * address. Settings alone shows it - a command line may hold a secret,
     * so the first mate and the crew never read it.
     */
    runs: z.string().max(2048).optional(),
    /** An MCP server lists every tool it has, so a row may carry many. */
    actions: z.array(integrationActionViewSchema).max(INTEGRATION_ACTIONS_MAX),
    /** What it can tell a listening rule; absent where it tells of nothing. */
    events: z.array(integrationEventViewSchema).max(256).optional(),
    /** The keys its kind signs in with, kept or not; absent when it declares none. */
    secrets: z.array(integrationSecretViewSchema).max(32).optional(),
  })
  .strict();
export type IntegrationView = z.infer<typeof integrationViewSchema>;

export const integrationsViewSchema = z
  .object({
    integrations: z.array(integrationViewSchema).max(64),
    /** The kinds that can be connected now, each once: the tab's add chips. */
    addable: z.array(z.object({ kind: integrationKindSchema, name: z.string() }).strict()).max(16),
  })
  .strict();
export type IntegrationsView = z.infer<typeof integrationsViewSchema>;

/**
 * A change to one integration's settings: a new name (null restores the
 * kind's), pause or resume, and actions turned on or off by name.
 */
export const integrationSettingsPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).nullable().optional(),
    paused: z.boolean().optional(),
    actions: z.record(integrationActionNameSchema, z.boolean()).optional(),
  })
  .strict();
export type IntegrationSettingsPatch = z.infer<typeof integrationSettingsPatchSchema>;

/**
 * An MCP server to add (docs/integrations.md, "MCP servers"): the person's
 * name for it, and what it runs - a program with its arguments, started on
 * this computer, or an https address (http only on this computer).
 */
export const integrationMcpAddSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    runs: z.string().trim().min(1).max(2048),
  })
  .strict();
export type IntegrationMcpAdd = z.infer<typeof integrationMcpAddSchema>;

/** The words Settings -> Integrations and the Projects tab's pointer show. */
export const INTEGRATIONS_WORDS = {
  title: "Integrations",
  intro:
    "What your first mate and your crew can reach outside your projects. Each row is one connection, signed in as you.",
  quiet: "Nothing connected yet.",
  pointer: "Your GitHub sign-in is in Integrations.",
  open: "Open Integrations",
} as const;

/** The words an open row's keys show (design skill `components/integrations/IntegrationRow`). */
export const INTEGRATION_SECRET_WORDS = {
  heading: "Keys",
  kept: "Kept on this computer",
  missing: "Not entered",
  placeholder: "Paste it here",
  save: "Save",
  replace: "Replace",
  remove: "Remove",
  stays: "It stays on this computer. Your first mate and your crew use it but never see it.",
} as const;

/** The words of the form that adds an MCP server. */
export const INTEGRATIONS_MCP_WORDS = {
  add: "MCP server",
  title: "Add an MCP server",
  name: "Name",
  namePlaceholder: "Linear",
  runs: "Runs",
  runsPlaceholder: "npx -y @example/mcp-server, or https://example.com/mcp",
  runsHint:
    "A program and its arguments, started on this computer when someone uses it, or the server's https address.",
  connect: "Connect",
  connecting: "Connecting…",
  cancel: "Cancel",
  connected: "connected",
  remove: "Remove",
  /** An event's badge, beside the actions' "reads" and "changes". */
  events: "tells",
} as const;

/** The words for what an action does, as its row shows them. */
export const INTEGRATION_EFFECT_WORDS: Record<IntegrationEffect, string> = {
  reads: "reads",
  changes: "changes",
  sends: "sends",
};

/** The words for an action's rule, as its row shows them. */
export const INTEGRATION_RULE_WORDS: Record<IntegrationRule, string> = {
  allow: "Allowed",
  ask: "Asks you",
  never: "Off",
};

/** The host whose sign-in lives in Settings -> Integrations rather than Projects. */
export const INTEGRATIONS_SIGN_IN_HOST = "github.com";

/**
 * The Settings section an `open` effect lands on: its target, except that
 * a GitHub sign-in opens Settings -> Integrations, which owns it (INF-775,
 * the captain's q2), so a card naming `projects` with `signIn: "github.com"`
 * - written before the move, or by a host card - lands where it lives now.
 */
export function openedSection(effect: { target: string; signIn?: string | undefined }): string {
  return effect.target === "projects" && effect.signIn === INTEGRATIONS_SIGN_IN_HOST
    ? "integrations"
    : effect.target;
}
