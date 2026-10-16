import { z } from "zod";
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
 * Slots the renderer hosts today. `agent-pack` is reserved in the taxonomy
 * and deliberately has no manifest entry yet: its host is the agent, not
 * the UI, and its contract is named when that host exists.
 */
export const HOSTED_CONTRIBUTION_SLOTS = ["card-kind", "settings-section", "side-panel"] as const;

const KEBAB_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const pluginIdSchema = z.string().min(2).max(64).regex(KEBAB_ID, "kebab-case id");
const contributionIdSchema = z.string().min(1).max(64).regex(KEBAB_ID, "kebab-case id");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// --- contributions --------------------------------------------------------

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
 * declaration side only - what a plugin may ASK for. Performing a request,
 * holding a secret, or serving a read is the phase-3 host's job, and none
 * of it exists until a concrete want opens that phase.
 */

export const NET_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type NetMethod = (typeof NET_METHODS)[number];
/** Granted by default; anything else is its own consent line. */
export const NET_READ_METHODS: readonly NetMethod[] = ["GET", "HEAD"];

/** Request bounds the mediated fetch must honour (proposal section 5.2). */
export const NET_BOUNDS = {
  timeoutMs: 15_000,
  responseMaxBytes: 1_048_576,
  maxInFlight: 4,
  maxPerMinute: 60,
} as const;

/** The most a plugin may ask for in namespaced KV storage. */
export const STORAGE_KV_MAX_BYTES = 1_048_576;

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

/**
 * Hosts a manifest may never name. Loopback, link-local, and RFC 1918
 * ranges are refused at declaration; the phase-3 executor re-checks the
 * resolved address, because a public name can resolve privately.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  ) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * An exact https origin: scheme + host (+ explicit port), nothing else. No
 * path, no wildcard, no credentials, no private host. `new URL` normalises
 * case and IDNs, so the declared string must already be the normalised form.
 */
export function isExactHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.origin !== value) return false;
  if (url.username || url.password) return false;
  const host = url.hostname;
  if (host.includes("*")) return false;
  if (isPrivateOrLoopbackHost(host)) return false;
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.startsWith("[");
  return ipv4 || ipv6 || HOSTNAME.test(host);
}

export const httpsOriginSchema = z
  .string()
  .max(253 + 14)
  .refine(isExactHttpsOrigin, "an exact https origin (no path, wildcard, or private host)");

const netMethodsSchema = z
  .array(z.enum(NET_METHODS))
  .min(1)
  .max(NET_METHODS.length)
  .default([...NET_READ_METHODS])
  .superRefine((methods, ctx) => {
    if (new Set(methods).size !== methods.length) {
      ctx.addIssue({ code: "custom", message: "duplicate method" });
    }
  });

const netAliasSchema = z.string().min(1).max(32).regex(KEBAB_ID, "kebab-case alias");

export const netOriginGrantSchema = z.union([
  z.strictObject({ origin: httpsOriginSchema, methods: netMethodsSchema }),
  /** The user types the host at install (a per-tenant service such as Jira). */
  z.strictObject({ userSupplied: z.literal(true), methods: netMethodsSchema }),
]);
export type NetOriginGrant = z.infer<typeof netOriginGrantSchema>;

export const secretSlotSchema = z.strictObject({
  kind: z.enum(["bearer", "basic", "header"]),
  /** Shown on the host-rendered secret row; the value itself has no field. */
  label: z.string().min(1).max(80),
  /** Required for `header`: the request header the host injects into. */
  header: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
});
export type SecretSlot = z.infer<typeof secretSlotSchema>;

const readNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, "dotted read-catalog name");

export const capabilitiesSchema = z.strictObject({
  net: z
    .strictObject({
      origins: z.record(netAliasSchema, netOriginGrantSchema).superRefine((origins, ctx) => {
        const supplied = Object.values(origins).filter((grant) => "userSupplied" in grant);
        if (supplied.length > 1) {
          ctx.addIssue({ code: "custom", message: "at most one alias may be userSupplied" });
        }
      }),
    })
    .optional(),
  secrets: z
    .record(netAliasSchema, secretSlotSchema)
    .superRefine((slots, ctx) => {
      for (const [name, slot] of Object.entries(slots)) {
        if (slot.kind === "header" && !slot.header) {
          ctx.addIssue({
            code: "custom",
            message: `secret "${name}" of kind header names no header`,
          });
        }
        if (slot.kind !== "header" && slot.header) {
          ctx.addIssue({
            code: "custom",
            message: `secret "${name}" sets header for kind ${slot.kind}`,
          });
        }
      }
    })
    .optional(),
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
});
export type PluginCapabilities = z.infer<typeof capabilitiesSchema>;

export const GRANT_NAMES = [
  "net.origins",
  "secrets",
  "storage.kv",
  "reads",
  "sql",
  "moves",
] as const;
export type GrantName = (typeof GRANT_NAMES)[number];

/** Which grants a manifest actually asks for, by name. */
export function requestedGrants(capabilities: PluginCapabilities): GrantName[] {
  const names: GrantName[] = [];
  if (capabilities.net && Object.keys(capabilities.net.origins).length > 0)
    names.push("net.origins");
  if (capabilities.secrets && Object.keys(capabilities.secrets).length > 0) names.push("secrets");
  if (capabilities.storage?.kv) names.push("storage.kv");
  if (capabilities.reads && capabilities.reads.length > 0) names.push("reads");
  if (capabilities.sql && capabilities.sql.length > 0) names.push("sql");
  if (capabilities.moves) names.push("moves");
  return names;
}

/** What a host is able to serve; every field defaults to "nothing". */
export type HostCapabilitySupport = {
  readonly net?: boolean;
  readonly secrets?: boolean;
  readonly storage?: boolean;
  /** The read catalog's entry names. Absent or empty means no reads at all. */
  readonly reads?: ReadonlySet<string>;
  /** The views of the record this host publishes. Absent or empty means no queries at all. */
  readonly sql?: ReadonlySet<string>;
  /** It serves a plugin's moves on the captain's tasks. */
  readonly moves?: boolean;
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
    if (grant === "net.origins" && !support.net) refused.push(grant);
    if (grant === "secrets" && !support.secrets) refused.push(grant);
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
  }
  return refused;
}

/**
 * The consent unit is the pair (proposal section 5.3): whatever a plugin can
 * read, it can send to the hosts it was granted. A ceremony renders both
 * halves in one sentence; a capability diff on update re-runs it.
 */
export type ConsentSummary = {
  reads: string[];
  /** The views of the app's record it can query: what it can read, by name. */
  views: string[];
  /** Origins data may leave for; `userSupplied` reads as a host the user chose. */
  sendsTo: string[];
  /** Origins granted a write method. */
  writesTo: string[];
  secretSlots: string[];
  storageBytes: number | null;
  /** It may move the captain's tasks, each move on his click or key. */
  moves: boolean;
};

export function consentSummary(capabilities: PluginCapabilities): ConsentSummary {
  const origins = Object.values(capabilities.net?.origins ?? {});
  const label = (grant: NetOriginGrant) =>
    "userSupplied" in grant ? "a host you choose" : grant.origin;
  return {
    reads: [...(capabilities.reads ?? [])],
    views: [...(capabilities.sql ?? [])],
    sendsTo: origins.map(label),
    writesTo: origins
      .filter((grant) => grant.methods.some((method) => !NET_READ_METHODS.includes(method)))
      .map(label),
    secretSlots: Object.keys(capabilities.secrets ?? {}),
    storageBytes: capabilities.storage?.kv.maxBytes ?? null,
    moves: capabilities.moves === true,
  };
}

// --- the manifest -----------------------------------------------------------

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

/** Parses a manifest, turning zod's issue list into one loud error. */
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
 * the order-free lists (reads, views, methods) sorted, empty grants gone.
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
  if (parsed.secrets && Object.keys(parsed.secrets).length > 0) block.secrets = parsed.secrets;
  if (parsed.net && Object.keys(parsed.net.origins).length > 0) {
    block.net = {
      origins: Object.fromEntries(
        Object.entries(parsed.net.origins).map(([alias, grant]) => [
          alias,
          { ...grant, methods: [...grant.methods].sort() },
        ]),
      ),
    };
  }
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
