import { z } from "zod";
import { PANEL_CHANGE_NAMES } from "../panelChanges";
import { SQL_VIEWS, sqlViewNameSchema } from "../sql";
import {
  PANEL_CARD_VIEWS_MAX,
  PANEL_NAME_PATTERN,
  panelCardsDeclarationSchema,
  panelCommandsSchema,
  panelHeaderSchema,
} from "./panelCards";

/**
 * The UI plugin manifest (phase 0 of the plugin system, docs/ui-plugins.md).
 *
 * A manifest is DATA: what a plugin contributes to which slot, and which
 * capabilities it asks for. It never names code. This file lives in
 * src/shared/ because the manifest is protocol-shaped - JSON-serializable,
 * zod-validated, readable by the core and by any client - so when phase 1
 * pushes contributions over the core/host contract the schema is already
 * where the contract lives (docs/architecture.md section 17).
 *
 * Two rules the schema enforces on its own:
 *
 * - Every object is strict. An unknown key anywhere - a capability the host
 *   has never heard of, a stray `main`/`entry`/`script` pointing at code -
 *   is refused loudly at parse time rather than ignored.
 * - The `capabilities` block is required even when empty. Phase 3 (the
 *   installable capability model, gated on a concrete want) reads grants
 *   from here; a manifest that omits the block is malformed, not "no
 *   grants".
 */

/** The four contribution slots (captain-accepted taxonomy). */
export const CONTRIBUTION_SLOTS = [
  "card-kind",
  "settings-section",
  "side-panel",
  "agent-pack",
] as const;
export type ContributionSlot = (typeof CONTRIBUTION_SLOTS)[number];

/**
 * Slots the renderer hosts today. Guidance runbooks use runbook.json through
 * Runbooks and the installer, not renderer contributions; the agent-pack
 * taxonomy slot remains unmounted here.
 */
export const HOSTED_CONTRIBUTION_SLOTS = ["card-kind", "settings-section", "side-panel"] as const;

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const pluginIdSchema = z.string().min(2).max(64).regex(KEBAB_ID, "kebab-case id");
const contributionIdSchema = z.string().min(1).max(64).regex(KEBAB_ID, "kebab-case id");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * How a card kind is dressed. The names are the design system's response
 * card kinds displayed by the host.
 * `record` dresses the host-owned task-record card (task-system P4).
 */
export const cardChromeSchema = z.enum(["decision", "note", "attention", "record"]);
export type CardChrome = z.infer<typeof cardChromeSchema>;

export const cardKindEntrySchema = z.strictObject({
  /** The presentation this describes (`cardPresentation` in cards.ts), or a plugin's own. */
  kind: contributionIdSchema,
  chrome: cardChromeSchema,
  body: z.strictObject({
    /**
     * Legacy compatibility field, accepted but no longer read: `plain` showed the body as linked
     * text (a report mid-flight), `html` renders it in the frame as usual.
     */
    streaming: z.enum(["plain", "html"]),
  }),
});
export type CardKindEntry = z.infer<typeof cardKindEntrySchema>;

export const settingsSectionEntrySchema = z.strictObject({
  id: contributionIdSchema,
  /** Tab label, sentence case. */
  label: z.string().min(1).max(24),
  /** Lower sorts first; ties break on id. */
  order: z.number().int().min(0).max(1_000),
  /** Settings is one centred column. Default is the Intelligence wide shell. */
  width: z.enum(["standard", "wide"]).default("wide"),
});
export type SettingsSectionEntry = z.infer<typeof settingsSectionEntrySchema>;

export const railSideSchema = z.enum(["left", "right"]);
export type RailSide = z.infer<typeof railSideSchema>;

export const railYSchema = z.enum(["top", "bottom"]);
export type RailY = z.infer<typeof railYSchema>;

/** Where a panel asks to sit: which rail, and where in its stack. */
export const sidePanelPlacementSchema = z.strictObject({
  x: railSideSchema,
  y: railYSchema,
});
export type SidePanelPlacement = z.infer<typeof sidePanelPlacementSchema>;

/**
 * How much of its rail a panel asks for. `content` hugs what it shows (a
 * strip, a short list); `fill` takes the rail height its siblings leave (a
 * feed, a long queue). A rail is a flex column, so several `fill` panels
 * share the remainder; the host still owns the chrome and the collapse.
 */
export const sidePanelSizeSchema = z.enum(["content", "fill"]);
export type SidePanelSize = z.infer<typeof sidePanelSizeSchema>;

export const sidePanelEntrySchema = z.strictObject({
  id: contributionIdSchema,
  /** Host-rendered panel title, sentence case. */
  title: z.string().min(1).max(40),
  /** A preference; the host decides final placement (D5). */
  preferredPlacement: sidePanelPlacementSchema,
  order: z.number().int().min(0).max(1_000),
  size: sidePanelSizeSchema.default("content"),
  /**
   * The panel reads newest last. When the window gives it less room than its
   * page asks, the host shows the page's end, so the newest line stays in
   * sight without the page asking the window to scroll.
   */
  newestLast: z.boolean().default(false),
  /**
   * The panel's cards on the main card stack (docs/ui-plugins.md, "A
   * panel's cards"): its card views, the cards its header buttons and
   * commands put up by name, the buttons the host draws in its header, and
   * the commands it adds to command search. Data the host reads and draws
   * as its own chrome; a panel without them has none.
   */
  cardViews: z.array(z.string().regex(PANEL_NAME_PATTERN)).max(PANEL_CARD_VIEWS_MAX).optional(),
  cards: panelCardsDeclarationSchema.optional(),
  header: panelHeaderSchema.optional(),
  commands: panelCommandsSchema.optional(),
});
export type SidePanelEntry = z.infer<typeof sidePanelEntrySchema>;

function uniqueIds<T>(items: T[], id: (item: T) => string, ctx: z.RefinementCtx, slot: string) {
  const seen = new Set<string>();
  for (const item of items) {
    const key = id(item);
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", message: `duplicate ${slot} id "${key}"` });
    }
    seen.add(key);
  }
}

export const contributionsSchema = z.strictObject({
  cardKinds: z
    .array(cardKindEntrySchema)
    .default([])
    .superRefine((items, ctx) => uniqueIds(items, (item) => item.kind, ctx, "card-kind")),
  settingsSections: z
    .array(settingsSectionEntrySchema)
    .default([])
    .superRefine((items, ctx) => uniqueIds(items, (item) => item.id, ctx, "settings-section")),
  sidePanels: z
    .array(sidePanelEntrySchema)
    .default([])
    .superRefine((items, ctx) => uniqueIds(items, (item) => item.id, ctx, "side-panel")),
});
export type PluginContributions = z.infer<typeof contributionsSchema>;

// --- capabilities (D6, the declaration side) --------------------------------

/**
 * The grant model. Every grant is named, so it can be consented to and
 * revoked individually; every bound is concrete. The schema carries the
 * declaration side: what a plugin may ASK for. Serving a read, a view, its
 * store or an integration is the host's job.
 *
 * A panel brings no host, key or sign-in of its own (the captain's
 * principle, 2026-11-02, "Integrations reach every surface the same way"):
 * a service outside the captain's projects is reached only through an
 * integration, named under `integrations`. The per-plugin hosts and keys
 * (`net`, `secrets`) the first proposal sketched are retired: a manifest
 * naming either is refused with `RETIRED_GRANT_WORDS`.
 */

/** The most a plugin may ask for in namespaced KV storage. */
export const STORAGE_KV_MAX_BYTES = 1_048_576;

/** Why a manifest naming `net` or `secrets` is refused. */
export function retiredGrantWords(key: string): string {
  return `"${key}" is retired: a panel reaches a service outside your projects only through an integration. Name the connection, its actions and why under "integrations".`;
}

/** An integration's name or id, an action's name, or an event's name, as a manifest spells it. */
const integrationWordSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s/][^/]*$/, "a name with no slash");
const eventWordSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[^\s/][^/]*$/, "a name with no slash");

/**
 * One integration a panel uses (`PanelIntegrationUse`): the connection by
 * its name or id, the actions it calls, the events it hears, and why.
 * It names at least one action or event.
 */
export const panelIntegrationUseSchema = z
  .strictObject({
    integration: integrationWordSchema,
    actions: z.array(integrationWordSchema).optional(),
    events: z.array(eventWordSchema).optional(),
    why: z.string().trim().min(1),
  })
  .superRefine((use, ctx) => {
    if (!use.actions?.length && !use.events?.length)
      ctx.addIssue({
        code: "custom",
        message: `"${use.integration}" names no action and no event`,
      });
  });

export const panelIntegrationsSchema = z
  .array(panelIntegrationUseSchema)
  .superRefine((uses, ctx) => {
    const seen = new Set<string>();
    for (const use of uses) {
      const key = use.integration.trim().toLowerCase();
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: `"${use.integration}" is named twice` });
      seen.add(key);
    }
  });
export type PanelIntegrationUseDeclared = z.infer<typeof panelIntegrationUseSchema>;

const readNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, "dotted read-catalog name");

/** An action catalog line's name, as a panel's `actions` grant spells it. */
export const actionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const capabilitiesSchema = z.strictObject({
  /** Retired: refused with `retiredGrantWords`. */
  net: z.never({ message: retiredGrantWords("net") }).optional(),
  /** Retired: refused with `retiredGrantWords`. */
  secrets: z.never({ message: retiredGrantWords("secrets") }).optional(),
  /** The integrations it uses, each under that action's own rule in Settings. */
  integrations: panelIntegrationsSchema.optional(),
  storage: z
    .strictObject({
      kv: z.strictObject({
        maxBytes: z.number().int().positive().max(STORAGE_KV_MAX_BYTES),
      }),
    })
    .optional(),
  /** Read-catalog entry names (phase 1 names the catalog; the host validates). */
  reads: z.array(readNameSchema).max(64).optional(),
  /**
   * The views of the app's record the plugin may query through the `sql`
   * read, by their exact versioned names (`v_usage_v1`; src/shared/sql.ts).
   * Naming at least one is what serves the read; `reads: ["sql"]` is not.
   */
  sql: z.array(sqlViewNameSchema).max(SQL_VIEWS.length).optional(),
  /**
   * It moves the captain's tasks - start, stop, continue, drop, queue,
   * unqueue - each only on his click or key in it (docs/ui-plugins.md, "A
   * panel's cards"). Never merge or discard.
   */
  moves: z.literal(true).optional(),
  /**
   * The app settings it may change, by the action catalog's line names,
   * each only on the captain's own press in it (docs/ui-plugins.md,
   * "Changing settings"); the host serves only the lines on its allowlist
   * (`PANEL_CHANGES`, src/shared/panelChanges.ts).
   */
  actions: z.array(actionNameSchema).max(PANEL_CHANGE_NAMES.length).optional(),
});
export type PluginCapabilities = z.infer<typeof capabilitiesSchema>;

export const GRANT_NAMES = [
  "integrations",
  "storage.kv",
  "reads",
  "sql",
  "moves",
  "actions",
] as const;
export type GrantName = (typeof GRANT_NAMES)[number];

export function requestedGrants(capabilities: PluginCapabilities): GrantName[] {
  const names: GrantName[] = [];
  if (capabilities.integrations && capabilities.integrations.length > 0) names.push("integrations");
  if (capabilities.storage?.kv) names.push("storage.kv");
  if (capabilities.reads && capabilities.reads.length > 0) names.push("reads");
  if (capabilities.sql && capabilities.sql.length > 0) names.push("sql");
  if (capabilities.moves) names.push("moves");
  if (capabilities.actions && capabilities.actions.length > 0) names.push("actions");
  return names;
}

/** What a host is able to serve; every field defaults to "nothing". */
export type HostCapabilitySupport = {
  /** It serves a panel's integrations (`PanelProps.integrations`). */
  readonly integrations?: boolean;
  readonly storage?: boolean;
  /** The read catalog's entry names. Absent or empty means no reads at all. */
  readonly reads?: ReadonlySet<string>;
  /** The views of the record this host publishes. Absent or empty means no queries at all. */
  readonly sql?: ReadonlySet<string>;
  /** It serves a plugin's moves on the captain's tasks. */
  readonly moves?: boolean;
  /** The settings a plugin may change, by catalog line. Absent or empty means none. */
  readonly actions?: ReadonlySet<string>;
};

/**
 * Grants this host cannot honour, spelled out for a loud refusal. A grant
 * the host does not serve is refused, never silently dropped: a plugin that
 * declared it would otherwise run believing it had the capability.
 */
export function unservableGrants(
  capabilities: PluginCapabilities,
  support: HostCapabilitySupport,
): string[] {
  const refused: string[] = [];
  for (const grant of requestedGrants(capabilities)) {
    if (grant === "integrations" && !support.integrations) refused.push(grant);
    if (grant === "storage.kv" && !support.storage) refused.push(grant);
    if (grant === "moves" && !support.moves) refused.push(grant);
    if (grant === "reads") {
      for (const name of capabilities.reads ?? []) {
        // The `sql` read is served by the `sql` grant, which names the
        // views; declared as a bare read it would reach nothing.
        if (name === "sql" || !support.reads?.has(name)) refused.push(`reads:${name}`);
      }
    }
    if (grant === "sql") {
      for (const view of capabilities.sql ?? []) {
        if (!support.sql?.has(view)) refused.push(`sql:${view}`);
      }
    }
    if (grant === "actions") {
      for (const name of capabilities.actions ?? []) {
        if (!support.actions?.has(name)) refused.push(`actions:${name}`);
      }
    }
  }
  return refused;
}

/**
 * What a ceremony words: what a plugin can read, and which integrations it
 * uses for what. A capability diff on update re-runs it.
 */
export type ConsentSummary = {
  reads: string[];
  /** The views of the app's record it can query: what it can read, by name. */
  views: string[];
  /** The integrations it uses, each with its actions, events and why. */
  integrations: PanelIntegrationUseDeclared[];
  storageBytes: number | null;
  /** It may move the captain's tasks, each move on his click or key. */
  moves: boolean;
  /** The settings it may change, each on his click or key. */
  actions: string[];
};

export function consentSummary(capabilities: PluginCapabilities): ConsentSummary {
  return {
    reads: [...(capabilities.reads ?? [])],
    views: [...(capabilities.sql ?? [])],
    integrations: (capabilities.integrations ?? []).map((use) => ({ ...use })),
    storageBytes: capabilities.storage?.kv.maxBytes ?? null,
    moves: capabilities.moves === true,
    actions: [...new Set(capabilities.actions ?? [])],
  };
}

export const pluginManifestSchema = z.strictObject({
  id: pluginIdSchema,
  /** Human name; the host renders it as the attribution on every contribution. */
  name: z.string().min(1).max(40),
  version: z.string().regex(SEMVER, "semver"),
  contributes: contributionsSchema,
  capabilities: capabilitiesSchema,
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

export class PluginManifestError extends Error {
  constructor(
    readonly pluginId: string | undefined,
    message: string,
  ) {
    super(pluginId ? `plugin "${pluginId}": ${message}` : `plugin manifest: ${message}`);
    this.name = "PluginManifestError";
  }
}

export function parsePluginManifest(raw: unknown): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const id =
    raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : undefined;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  throw new PluginManifestError(id, issues);
}

/**
 * A capability block in one canonical spelling: keys sorted at every level,
 * the order-free lists (reads, views, integrations and their names) sorted, empty grants gone.
 * Two blocks that grant the same thing canonicalize to the same text, which
 * is what "re-consent only on a capability diff" compares (Phase A, A2a).
 */
export function canonicalCapabilities(capabilities: PluginCapabilities): string {
  const parsed = capabilitiesSchema.parse(capabilities);
  const block: Record<string, unknown> = {};
  if (parsed.reads?.length) block.reads = [...new Set(parsed.reads)].sort();
  if (parsed.sql?.length) block.sql = [...new Set(parsed.sql)].sort();
  if (parsed.storage) block.storage = parsed.storage;
  if (parsed.moves) block.moves = true;
  if (parsed.actions?.length) block.actions = [...new Set(parsed.actions)].sort();
  if (parsed.integrations?.length)
    block.integrations = [...parsed.integrations]
      .map((use) => ({
        integration: use.integration,
        ...(use.actions?.length ? { actions: [...new Set(use.actions)].sort() } : {}),
        ...(use.events?.length ? { events: [...new Set(use.events)].sort() } : {}),
        why: use.why,
      }))
      .sort((a, b) => (a.integration < b.integration ? -1 : a.integration > b.integration ? 1 : 0));
  return JSON.stringify(sortKeys(block));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
