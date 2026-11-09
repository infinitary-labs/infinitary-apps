import { z } from "zod";
import {
  capabilitiesSchema,
  type HostCapabilitySupport,
  type PluginCapabilities,
  panelIntegrationsSchema,
  retiredGrantWords,
  STORAGE_KV_MAX_BYTES,
} from "../plugins/manifest";
import {
  PANEL_CARD_VIEWS_MAX,
  PANEL_NAME_PATTERN,
  panelCardsDeclarationSchema,
  panelCommandsSchema,
  panelHeaderSchema,
} from "../plugins/panelCards";
import { SQL_VIEWS, sqlViewNameSchema } from "../sql";
import type { PanelReadName, PersonalManifest, PersonalPresence, StoreValue } from "./contracts";

/**
 * The runtime side of the personal-extension contracts (src/shared/personal/
 * contracts.ts is the type-only public surface): the `manifest.json` schema,
 * the snapshot the core pushes to the renderer, the store's wire shapes, and
 * the constants both sides agree on. `contracts.test.ts` pins the zod
 * schemas to the public types so the generated `infinitary-env.d.ts` cannot
 * drift from what the host actually accepts.
 */

/**
 * An extension id is its directory name: kebab-case, like a plugin id, and
 * short enough that its plugin id (`personal-<id>`, PERSONAL_PLUGIN_PREFIX)
 * still fits the manifest's 64.
 */
export const PERSONAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const PERSONAL_ID_MAX_LENGTH = 48;
export const personalIdSchema = z
  .string()
  .min(2)
  .max(PERSONAL_ID_MAX_LENGTH)
  .regex(PERSONAL_ID_PATTERN);
/** The plugin id a personal extension registers under in the renderer's host. */
export const PERSONAL_PLUGIN_PREFIX = "personal-";
/** The attribution mark on every personal panel's header: the captain's own, never a name. */
export const PERSONAL_ATTRIBUTION = "yours";
/** The plugin id an installed plugin registers under; its header reads its manifest's `name`. */
export const INSTALLED_PLUGIN_PREFIX = "installed-";

/**
 * The id the window draws a panel's draft under while a crewmate builds it
 * (docs/personal-panels.md, "Built apart"): out of sight, where the
 * crewmate's capture photographs it and nothing else reaches it. A dot is
 * outside PERSONAL_ID_PATTERN, so no panel of the app's or the captain's
 * ever has it.
 */
export function personalDraftPanelId(id: string): string {
  return `${id}.draft`;
}

/**
 * Where a plugin came from (one plugin vehicle, Phase A; captain's A1a):
 * `yours` is the captain's own personal workspace, `installed` one he added
 * from npm, a git address or a folder. The host stamps it from the root it
 * found the plugin in - never from the manifest - and it decides the
 * privilege, never how the plugin is written.
 */
export const PLUGIN_SOURCES = ["yours", "installed"] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/** The floor a background task's cadence is clamped up to. */
export const MIN_BACKGROUND_INTERVAL_MS = 60_000;

/** The most one extension's store slice may hold, in bytes of JSON. */
export const PERSONAL_STORE_MAX_BYTES = 1_048_576;
/** The most one value may take, in bytes of JSON. */
export const PERSONAL_STORE_VALUE_MAX_BYTES = 262_144;
export const PERSONAL_STORE_KEY_MAX_LENGTH = 128;

/** The host modules a panel may import; the compiler admits nothing else from npm. */
export const PERSONAL_HOST_MODULES = {
  react: "react",
  "react/jsx-runtime": "jsxRuntime",
  "react/jsx-dev-runtime": "jsxDevRuntime",
  "@infinitary/ui": "ui",
} as const;
export type HostModuleSpecifier = keyof typeof PERSONAL_HOST_MODULES;
export type HostModuleKey = (typeof PERSONAL_HOST_MODULES)[HostModuleSpecifier];

/**
 * The app's own reads a panel may declare (talk-to-personalize Step 4,
 * captain decision Q3: app data through the read catalog). Each is a read
 * catalog entry (`src/shared/reads.ts`); the host serves a panel exactly
 * the names its manifest lists, and nothing else in the catalog.
 */
export const PANEL_READ_NAMES = [
  "computers.resources",
  "quota.snapshot",
  "tasks.board",
  "tasks.detail",
  "tasks.search",
  "feed.recent",
  "forge.changes",
  "automation.list",
  "knowledge.collections",
  "knowledge.graph",
  "knowledge.concepts",
  "knowledge.directions",
  "knowledge.findings",
  "knowledge.entry",
  "knowledge.direction",
] as const;
export const panelReadNameSchema: z.ZodType<PanelReadName> = z.enum(PANEL_READ_NAMES);

/**
 * Why `reads.subscribe` threw: the panel named a read its manifest did not
 * declare. One wording for both realms - the app's own window and the
 * frame realm - so a panel moved between them fails the same way.
 */
export function undeclaredReadMessage(name: string): string {
  return `"${name}" is not a read this panel declared: name it in manifest.json "reads" (one of ${PANEL_READ_NAMES.join(", ")}).`;
}

/**
 * The one wording for an integration call or event a panel's manifest does
 * not name (`manifest.json` `integrations`): the service answers it as a
 * refusal, and the panel lint says it at the call.
 */
export function undeclaredIntegrationMessage(
  integration: string,
  what?: { action: string } | { event: string },
): string {
  const named = !what
    ? `"${integration}"`
    : "action" in what
      ? `"${integration}"'s action "${what.action}"`
      : `"${integration}"'s event "${what.event}"`;
  return `Not run: this panel's manifest.json does not name ${named} under "integrations". Name the connection, its actions or events, and why there.`;
}

/**
 * Where the app hands a panel an integration's event (`PanelIntegrations.on`):
 * one key of its own store slice per connection, as the manifest spells it,
 * and event, holding the latest look's items (`PanelEventEntry`). The panel's
 * background code and its drawing both hear it from there.
 */
export const PANEL_EVENT_KEY_PREFIX = "integrations:";
export function panelEventKey(integration: string, event: string): string {
  return `${PANEL_EVENT_KEY_PREFIX}${integration}/${event}`;
}
/** What an event key holds: when the app looked, what arrived since the look before. */
export type PanelEventEntry = {
  at: number;
  items: { id: string; summary: string }[];
  /** Arrivals retained by the owner for subsequent ticks, before another look. */
  remaining?: number;
  /** Arrivals too large for one store value; the app also logs this loss. */
  dropped?: number;
  /** The place could not answer from where the last look ended; what happened between is not known. */
  resynced?: true;
};

/**
 * Why a panel's `point` threw: pointing names tasks and cards by the ids
 * the board read gave, so a panel that does not read it cannot point.
 */
export function pointNeedsBoardMessage(call: string): string {
  return `point.${call} points at tasks the board lists: name "tasks.board" in manifest.json "reads".`;
}

/** Why `tasks.run` is not there: the manifest did not ask for moves. */
export function undeclaredMovesMessage(): string {
  return `tasks.run moves the captain's tasks: say "moves": true in manifest.json.`;
}

/** Why `reads.subscribe("sql", ...)` threw: the manifest declared no view. */
export function undeclaredViewsMessage(): string {
  return `"sql" reads the views this panel declared: name them in manifest.json "sql" (from ${SQL_VIEWS.join(", ")}).`;
}

/**
 * The type-only module; a value import of it is refused at compile. A panel
 * written before the Infinitary rename names it `@firstmate/contracts`, which
 * the compiler reads as this one (`ownHostModule`).
 */
export const PERSONAL_CONTRACTS_MODULE = "@infinitary/contracts";

export const storeValueSchema: z.ZodType<StoreValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(storeValueSchema),
    z.record(z.string(), storeValueSchema),
  ]),
);

export const storeEntrySchema = z.object({
  key: z.string(),
  value: storeValueSchema,
  updatedAt: z.number(),
});

export const personalPresenceSchema: z.ZodType<PersonalPresence> = z.union([
  z.strictObject({ always: z.literal(true) }),
  z.strictObject({
    store: z.string().min(1).max(PERSONAL_STORE_KEY_MAX_LENGTH),
    when: z.literal("nonEmpty"),
  }),
  z.strictObject({ code: z.literal(true) }),
]);

export const personalPlacementSchema = z.strictObject({
  x: z.enum(["left", "right"]),
  y: z.enum(["top", "bottom"]),
});

/**
 * `manifest.json` as written; strict, every field optional. The ONE plugin
 * manifest (Phase A item 1): the capability keys (`reads`, `sql`, `moves`,
 * `integrations`, `storage`) are the grant model's block, spelled at the top
 * level where the captain's own panels already declare `reads` and `sql`,
 * so every existing manifest is already this shape. `manifestCapabilities`
 * reads them as the grant block `unservableGrants` and `consentSummary`
 * take; the capability schema re-checks them there.
 */
export const personalManifestSchema: z.ZodType<PersonalManifest> = z.strictObject({
  api: z
    .union([z.literal(1), z.literal(2)], {
      message: "this panel is written for a version of the panel API this app does not serve",
    })
    .optional(),
  name: z.string().min(1).max(40).optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "semver")
    .optional(),
  title: z.string().min(1).max(40).optional(),
  placement: personalPlacementSchema.optional(),
  order: z.number().int().min(0).max(1_000).optional(),
  size: z.enum(["content", "fill"]).optional(),
  /** Reads newest last: the window keeps the panel's end in sight when it gives the panel less room than its page asks. */
  newestLast: z.boolean().optional(),
  presence: personalPresenceSchema.optional(),
  cards: panelCardsDeclarationSchema.optional(),
  header: panelHeaderSchema.optional(),
  commands: panelCommandsSchema.optional(),
  reads: z.array(panelReadNameSchema).max(PANEL_READ_NAMES.length).optional(),
  moves: z.literal(true).optional(),
  sql: z.array(sqlViewNameSchema).max(64).optional(),
  integrations: panelIntegrationsSchema.optional(),
  /** Retired: a panel reaches a service through an integration (`retiredGrantWords`). */
  net: z.never({ message: retiredGrantWords("net") }).optional(),
  /** Retired, with `net`. */
  secrets: z.never({ message: retiredGrantWords("secrets") }).optional(),
  storage: z
    .strictObject({
      kv: z.strictObject({ maxBytes: z.number().int().positive().max(STORAGE_KV_MAX_BYTES) }),
    })
    .optional(),
  origin: z.strictObject({ taskId: z.string().min(1).max(64).optional() }).optional(),
});

/**
 * The manifest's capability keys as the grant model's block: what
 * `unservableGrants` checks, `consentSummary` words, and an installed
 * plugin's consent records. A block the capability schema refuses (two
 * user-supplied hosts, a header secret naming no header) throws, with the
 * issue named.
 */
export function manifestCapabilities(manifest: PersonalManifest): PluginCapabilities {
  return capabilitiesSchema.parse({
    ...(manifest.moves ? { moves: true } : {}),
    ...(manifest.reads?.length ? { reads: [...manifest.reads] } : {}),
    ...(manifest.sql?.length ? { sql: [...manifest.sql] } : {}),
    ...(manifest.integrations?.length ? { integrations: manifest.integrations } : {}),
    ...(manifest.storage ? { storage: manifest.storage } : {}),
  });
}

/**
 * What the plugin host serves a plugin of either source: the panel reads,
 * the published views, its own store slice, its moves, and the
 * integrations it names, each under that action's own rule in Settings.
 */
export const PLUGIN_HOST_SUPPORT: HostCapabilitySupport = {
  integrations: true,
  reads: new Set(PANEL_READ_NAMES),
  sql: new Set(SQL_VIEWS),
  storage: true,
  moves: true,
};

/**
 * Where a panel that names no placement lands: the top of the left rail,
 * where the create-your-own-panel slot invited it (docs/personal-panels.md).
 */
export const DEFAULT_PERSONAL_PLACEMENT = { x: "left", y: "top" } as const;
export const DEFAULT_PERSONAL_ORDER = 100;

/**
 * The presence rule, in one place: a `store` presence is satisfied by any
 * value that is not empty. Absent, `null`, `""`, `[]` and `{}` are empty;
 * `0` and `false` are values. A `code` presence is the panel's own to
 * decide in its running page (`rail.show`), so the core mounts it always.
 */
export function presenceSatisfied(
  presence: PersonalPresence,
  read: (key: string) => StoreValue | undefined,
): boolean {
  if ("always" in presence || "code" in presence) return true;
  const value = read(presence.store);
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// --- the snapshot the renderer mounts from ----------------------------------

export const personalErrorSchema = z.object({
  /** Which file refused: the manifest, the panel graph, or the server graph. */
  stage: z.enum(["manifest", "panel", "server"]),
  /** Names the offending path, and the import when one is refused. */
  message: z.string(),
});
export type PersonalError = z.infer<typeof personalErrorSchema>;

export const personalExtensionViewSchema = z.object({
  id: personalIdSchema,
  /** Where it came from, stamped by the host (Phase A item 1). */
  source: z.enum(PLUGIN_SOURCES),
  /** An installed plugin's `name`: the attribution on its header. Null for the captain's own. */
  by: z.string().min(1).max(40).nullable(),
  title: z.string().min(1).max(40),
  placement: personalPlacementSchema,
  order: z.number().int(),
  size: z.enum(["content", "fill"]),
  newestLast: z.boolean().optional(),
  /** The presence rule's verdict right now; the renderer shows the panel only while true. */
  present: z.boolean(),
  /**
   * Its presence is its own code's to decide (`{ "code": true }`): its page
   * runs, and it is on its rail only while it says so (`rail.show`).
   */
  ownPresence: z.boolean(),
  /** It may move the captain's tasks: its manifest asks, and for an added one he agreed. */
  moves: z.boolean(),
  /** A task on this extension is active: the header shows the running dot. */
  running: z.boolean(),
  /** The app's own reads the manifest declared; the panel is served these and no other. */
  reads: z.array(panelReadNameSchema),
  /**
   * The views of the app's record the manifest declared (`sql`), every one
   * published by this version - a manifest naming one it does not publish is
   * an error and mounts nothing. The panel's queries reach these and no other.
   */
  sql: z.array(sqlViewNameSchema),
  /**
   * Always null: it named a compiled panel the window imported in-process,
   * which no panel is any more (INF-2205 piece C). Kept so an older reader
   * still parses the snapshot; it reads `frame`.
   */
  panel: z.object({ url: z.string(), version: z.string() }).nullable(),
  /**
   * The compiled panel the frame realm draws contained (Phase A item 4;
   * INF-2205 piece C), whatever its source: the version of the graph the
   * frame will load. Null when it has no panel, or its panel failed.
   */
  frame: z.object({ version: z.string() }).nullable(),
  /**
   * Its card views (`cards/<view>.tsx`), compiled beside its panel: the
   * views `cards.emit` may name. Empty for a panel with none.
   */
  cardViews: z.array(z.string().regex(PANEL_NAME_PATTERN)).max(PANEL_CARD_VIEWS_MAX),
  /** The cards its header buttons and commands put up, by name, as its manifest declares them. */
  cards: panelCardsDeclarationSchema,
  /** The buttons the app draws in its header. */
  header: panelHeaderSchema,
  /** The commands it adds to command search. */
  commands: panelCommandsSchema,
  /** What `server.ts` exported, after clamping, or null when there is none (or it failed). */
  server: z
    .object({
      actions: z.array(z.string()),
      background: z.array(z.object({ id: z.string(), everyMs: z.number() })),
    })
    .nullable(),
  error: personalErrorSchema.nullable(),
  /**
   * The app stopped its background work (INF-2205 piece B): it went silent
   * or ended on its own. The stop holds across reloads and restarts until
   * the captain's Retry; absent while nothing is stopped.
   */
  stopped: z
    .object({
      reason: z.enum(["unresponsive", "exited"]),
      /** When it was noticed, ISO wall time. */
      at: z.string(),
      /** The code version that was stopped. */
      version: z.string(),
    })
    .optional(),
  /**
   * The app refused its `server.ts` before it ran, because it is written for
   * a panel API this version no longer serves (INF-2470). The panel still
   * draws; the window says its background work is paused, with Update panel.
   * Absent while nothing is refused.
   */
  paused: z
    .object({
      /** The panel API its manifest names; 1 when it names none. */
      api: z.number().int().min(1),
      /** The panel APIs this version serves a `server.ts`. */
      serves: z.array(z.number().int().min(1)),
      /** The captain pressed Update panel and the first mate was told, for this code. */
      asked: z.boolean(),
    })
    .optional(),
  /**
   * Its integration calls waiting on the captain or turned down
   * (docs/integrations.md, "Panels"): one line each, which the window draws
   * with Ask again. Absent while none is.
   */
  integrationAsks: z
    .array(
      z.object({
        /** The integration's id, as Ask again names it. */
        integration: z.string().min(1).max(200),
        /** Its name when asked. */
        place: z.string().min(1).max(200),
        action: z.string().min(1).max(200),
        /** The action's few words, such as "Read from GitHub". */
        label: z.string().min(1).max(200),
        /** Its approval card is up, or the captain chose Not now. */
        state: z.enum(["asking", "declined"]),
      }),
    )
    .optional(),
});
export type PersonalExtensionView = z.infer<typeof personalExtensionViewSchema>;

export const personalSnapshotSchema = z.object({
  extensions: z.array(personalExtensionViewSchema),
  /**
   * The captain's own panels as the crewmates building them have them now
   * (docs/personal-panels.md, "Built apart"): the working files, run apart
   * from the rails, which keep each panel's last commit until the build's
   * report. Absent while nothing is being built.
   */
  drafts: z.array(personalExtensionViewSchema).optional(),
});
export type PersonalSnapshot = z.infer<typeof personalSnapshotSchema>;

// --- the wire shapes ---------------------------------------------------------------

export const personalStoreChangeSchema = z.object({
  extensionId: personalIdSchema,
  key: z.string(),
  /** The change was to the store of the extension's draft, never its panel's own. */
  draft: z.literal(true).optional(),
});
export type PersonalStoreChange = z.infer<typeof personalStoreChangeSchema>;

const storeKeySchema = z.string().min(1).max(PERSONAL_STORE_KEY_MAX_LENGTH);

/**
 * A request from an extension's draft (docs/personal-panels.md, "Built
 * apart"): it reaches the draft's own store or server, never the panel's.
 */
const draftFlag = z.literal(true).optional();

/** One channel, four operations, so the API grows by one verb, not four. */
export const personalStoreRequestSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("get"),
    extensionId: personalIdSchema,
    key: storeKeySchema,
    draft: draftFlag,
  }),
  z.object({
    op: z.literal("set"),
    extensionId: personalIdSchema,
    key: storeKeySchema,
    value: storeValueSchema,
    draft: draftFlag,
  }),
  z.object({
    op: z.literal("delete"),
    extensionId: personalIdSchema,
    key: storeKeySchema,
    draft: draftFlag,
  }),
  z.object({
    op: z.literal("list"),
    extensionId: personalIdSchema,
    prefix: z.string().max(PERSONAL_STORE_KEY_MAX_LENGTH).optional(),
    draft: draftFlag,
  }),
]);
export type PersonalStoreRequest = z.infer<typeof personalStoreRequestSchema>;

export const personalStoreResponseSchema = z.object({
  /** `get`: the value, absent when the key is unset. */
  value: storeValueSchema.optional(),
  /** `list`: the entries under the prefix, key order. */
  entries: z.array(storeEntrySchema).optional(),
});
export type PersonalStoreResponse = z.infer<typeof personalStoreResponseSchema>;

/** How an action call is addressed: `draft`, to the server of the extension's draft. */
export const personalInvokeOptionsSchema = z.object({ draft: draftFlag });
export type PersonalInvokeOptions = z.infer<typeof personalInvokeOptionsSchema>;

/**
 * A panel drawing's call on its integrations (docs/integrations.md,
 * "Panels"): the same three verbs its background code has. The core reads
 * which connections and actions the panel may reach from its own manifest,
 * never from the request.
 */
export const panelIntegrationsRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("show"), name: z.string().min(1).max(200) }),
  z.object({
    op: z.literal("call"),
    name: z.string().min(1).max(200),
    action: z.string().min(1).max(200),
    input: z.unknown().optional(),
  }),
]);
export type PanelIntegrationsRequest = z.infer<typeof panelIntegrationsRequestSchema>;

/**
 * What a panel drawing's integrations call answers: an action's answer or a
 * refusal (`PanelIntegrationAnswer`), the connections it names for `list`,
 * or one connection's actions for `show`.
 */
export const panelIntegrationsResponseSchema = z.union([
  z.object({ text: z.string(), refused: z.enum(["refused", "invalid"]).optional() }),
  z.array(z.record(z.string(), z.unknown())),
  z.record(z.string(), z.unknown()),
]);
export type PanelIntegrationsResponse = z.infer<typeof panelIntegrationsResponseSchema>;

export const personalInvokeResultSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PersonalInvokeResult = z.infer<typeof personalInvokeResultSchema>;
