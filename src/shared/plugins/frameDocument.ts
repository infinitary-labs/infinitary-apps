import { z } from "zod";
import { APP_FRAME_SCHEME } from "../csp";
import { currentLanguage } from "../i18n/current";
import { textDirection } from "../i18n/languages";
import { PANEL_READ_NAMES, personalIdSchema } from "../personal/manifest";
import { sqlViewNameSchema } from "../sql";
import { BUILTIN_FRAME_PANELS, FRAME_LIB_BOOT, frameLibUrl } from "./frameLib";
import { FRAME_BRIDGE_SCRIPT } from "./frameScript";
import { PANEL_NAME_PATTERN, panelCardIdSchema } from "./panelCards";

/**
 * The frame document (phase 1's template/data split, docs/ui-plugins.md).
 *
 * A TEMPLATE is what a plugin ships for a mount: markup, and optionally one
 * script that runs inside the sandboxed frame. It is instantiated once per
 * mount and stable for the life of the mount. DATA never lives in the
 * document: it is pushed over the bridge after the frame reports ready, so
 * a live surface never rebuilds its document to show a new value (the
 * srcdoc-rebuild constraint the proposal set out to remove).
 *
 * `buildFrameDocument` is the one assembler for every frame the host opens.
 * A card body calls it in the renderer and hands the result to `srcdoc`
 * (no template script, so the inherited app CSP is enough); a template
 * mount is assembled by the host and served at `app-frame://mount/<id>`
 * with the CSP as a response header, because a served document gets its
 * own policy and can therefore pin its template script by hash.
 */

/** The most template markup, script, or stylesheet a mount may carry. */
export const FRAME_TEMPLATE_MAX_BYTES = 524_288;

/** A closing tag inside embedded text would end the element early. */
function withoutClosingTag(tag: string) {
  const closing = new RegExp(`</${tag}`, "i");
  return (text: string) => !closing.test(text);
}

export const frameTemplateSchema = z.strictObject({
  /** Body markup. Scripts inside it never run: only `script` is hash-pinned. */
  html: z.string().max(FRAME_TEMPLATE_MAX_BYTES).refine(withoutClosingTag("body"), "a </body> tag"),
  /** The template's script, run inside the frame after the markup is parsed. */
  script: z
    .string()
    .min(1)
    .max(FRAME_TEMPLATE_MAX_BYTES)
    .refine(withoutClosingTag("script"), "a </script> tag")
    .optional(),
});
export type FrameTemplate = z.infer<typeof frameTemplateSchema>;

export const cardFrameTemplateSchema = z.strictObject({
  html: z.string().max(FRAME_TEMPLATE_MAX_BYTES),
});
export type CardFrameTemplate = z.infer<typeof cardFrameTemplateSchema>;

export const frameThemeSchema = z.enum(["dark", "light"]);
export type FrameTheme = z.infer<typeof frameThemeSchema>;

/** What the renderer hands the host to serve a mount. */
const frameMountBaseSchema = z.strictObject({
  /** Names the frame in the host's chrome and in its document title. */
  title: z.string().min(1).max(120),
  theme: frameThemeSchema,
  /** The design system's frame stylesheet: tokens, fonts, base rules. */
  style: z
    .string()
    .max(FRAME_TEMPLATE_MAX_BYTES)
    .refine(withoutClosingTag("style"), "a </style> tag"),
});

export const pluginFrameMountRequestSchema = frameMountBaseSchema.extend({
  template: frameTemplateSchema,
  kind: z.undefined().optional(),
});

export const cardFrameMountRequestSchema = frameMountBaseSchema.extend({
  template: cardFrameTemplateSchema,
  /**
   * An agent-authored card body whose own inline script runs (WI-16). It is
   * served from a host of its own, `app-frame://card-<id>/`, so the browser
   * gives it a site - and a renderer process - of its own.
   */
  kind: z.literal("card"),
});

/**
 * The panel module a panel mount draws (one plugin vehicle, Phase A items 4
 * and 6; INF-2205 piece C): one of the app's own panels, compiled into the
 * lib with the bundle, or the compiled version of one of the captain's own
 * panels or of a panel he added, which the shell reads out of its compile
 * cache - never a path the renderer names. Either way `view` names one of the panel's card views
 * (`cards/<view>.tsx`) instead of its panel: the document draws that card
 * for the stack (docs/ui-plugins.md, "A panel's cards").
 */
export const panelModuleSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("builtin"),
    id: z.enum(BUILTIN_FRAME_PANELS),
    view: z.string().regex(PANEL_NAME_PATTERN).optional(),
  }),
  z.strictObject({
    source: z.literal("installed"),
    id: personalIdSchema,
    /** The compiled graph's content hash (the compiler's 16 hex). */
    version: z.string().regex(/^[0-9a-f]{16}$/),
    /**
     * One of its card views (`cards/<view>.tsx`) instead of its panel: the
     * document draws that card for the stack (docs/ui-plugins.md, "A
     * panel's cards"), from the same compiled graph.
     */
    view: z.string().regex(PANEL_NAME_PATTERN).optional(),
  }),
  z.strictObject({
    /**
     * One of the captain's own panels (INF-2205 piece C): drawn here like
     * any other, never in the app's own window. The shell reads its compiled
     * graph out of the personal compile cache, asked of the core for exactly
     * this version - the panel on its rail, or its draft (`draft`) while a
     * crewmate builds it.
     */
    source: z.literal("personal"),
    id: personalIdSchema,
    version: z.string().regex(/^[0-9a-f]{16}$/),
    draft: z.literal(true).optional(),
    view: z.string().regex(PANEL_NAME_PATTERN).optional(),
  }),
]);
export type PanelModule = z.infer<typeof panelModuleSchema>;

/**
 * What the frame realm's runtime hands the panel as `PanelProps` beside the
 * bridge: its id, and the reads and views it declared - the same lists the
 * host's controller enforces, restated so an undeclared read throws at the
 * call the way it does in the app's own window.
 */
export const panelFrameConfigSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  reads: z.array(z.enum(PANEL_READ_NAMES)).max(PANEL_READ_NAMES.length),
  sql: z.array(sqlViewNameSchema).max(64),
  /**
   * Set when the document draws one of the panel's cards: the card's id,
   * which the runtime hands the view as `card.id`. Its data is pushed as
   * view state, so a revised card is heard without a new document.
   */
  card: z.strictObject({ id: panelCardIdSchema }).optional(),
  /**
   * The captain agreed it may move his tasks: the runtime hands it
   * `tasks`, whose one action the host declared for this mount alone.
   */
  moves: z.boolean().optional(),
  /**
   * The panel may have background work of its own (`server.ts`, the
   * captain's own panels only): the runtime hands it an `invoke` that asks
   * the host's `server.invoke` action, which the host declared for this
   * mount alone. Absent, `invoke` rejects at once.
   */
  server: z.boolean().optional(),
});
export type PanelFrameConfig = z.infer<typeof panelFrameConfigSchema>;

export const panelFrameMountRequestSchema = frameMountBaseSchema.extend({
  /**
   * A panel written in the plugin shape, drawn in the frame realm: the shell
   * serves the lib and the panel's modules to a document of its own at
   * `app-frame://panel-<id>/`.
   */
  kind: z.literal("panel"),
  panel: panelModuleSchema,
  config: panelFrameConfigSchema,
});

export const frameMountRequestSchema = z.union([
  cardFrameMountRequestSchema,
  panelFrameMountRequestSchema,
  pluginFrameMountRequestSchema,
]);
export type FrameMountRequest = z.infer<typeof frameMountRequestSchema>;
/** A mount whose document is its template: a plugin template or a card body. */
export type DocumentMountRequest = Exclude<FrameMountRequest, { kind: "panel" }>;
/** A mount whose document draws a panel in the frame realm. */
export type PanelMountRequest = Extract<FrameMountRequest, { kind: "panel" }>;

export const frameMountSchema = z.object({
  mountId: z.string().min(1).max(64),
  /** Where the iframe loads the document from. */
  url: z.string().startsWith(`${APP_FRAME_SCHEME}://`),
});
export type FrameMount = z.infer<typeof frameMountSchema>;

export function frameMountUrl(mountId: string): string {
  return `${APP_FRAME_SCHEME}://mount/${mountId}`;
}

/** The host prefix of a card mount; the rest of the host is the mount id. */
export const CARD_MOUNT_HOST_PREFIX = "card-";

/**
 * A card mount lives at its own host, not under `mount/`: a site is scheme
 * plus host, and the browser shares one renderer process per site, so a
 * path under a common host would put every card - and every plugin panel -
 * in the process a runaway card script wedges.
 */
export function cardMountUrl(mountId: string): string {
  return `${APP_FRAME_SCHEME}://${CARD_MOUNT_HOST_PREFIX}${mountId}/`;
}

/** The host prefix of a panel mount; the rest of the host is the mount id. */
export const PANEL_MOUNT_HOST_PREFIX = "panel-";

/**
 * A panel mount lives at its own host, like a card mount: its own site, so
 * its own renderer process - a panel that wedges its event loop wedges only
 * itself - and its own script source, so its modules are its own.
 */
export function panelMountHost(mountId: string): string {
  return `${PANEL_MOUNT_HOST_PREFIX}${mountId}`;
}

export function panelMountUrl(mountId: string): string {
  return `${APP_FRAME_SCHEME}://${panelMountHost(mountId)}/`;
}

export function frameFontUrl(file: string): string {
  return `${APP_FRAME_SCHEME}://fonts/${file}`;
}

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export type FrameDocumentParts = {
  csp: string;
  theme: FrameTheme;
  title?: string;
  style: string;
  html: string;
  script?: string;
  /**
   * A card's page (FI3-871): born held, so its own scripts and animations
   * wait for the host's `activate` (bridge.ts). A panel's never is.
   */
  held?: boolean;
  /** The language the document speaks, the app's own unless named (docs/i18n.md, "The language fact"). */
  language?: string;
};

/**
 * The `lang` and `dir` a frame's document is born with: the app's language
 * and the way its text runs, so a frame's own words and its layout follow
 * the window's (docs/i18n.md, "The language fact").
 */
function languageAttributes(language = currentLanguage()): string {
  return `lang="${escapeAttribute(language)}" dir="${textDirection(language)}"`;
}

/** Assembles one frame document. Pure for a given language; the same text on every host. */
export function buildFrameDocument(parts: FrameDocumentParts): string {
  const theme = escapeAttribute(parts.theme);
  return [
    "<!doctype html>",
    `<html ${languageAttributes(parts.language)} data-theme="${theme}"${parts.held ? " data-inf-held" : ""}>`,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
    '<meta charset="utf-8">',
    ...(parts.title ? [`<title>${escapeAttribute(parts.title)}</title>`] : []),
    `<style>${parts.style}</style>`,
    `<script>${FRAME_BRIDGE_SCRIPT}</script>`,
    "</head>",
    `<body data-theme="${theme}">`,
    parts.html,
    ...(parts.script ? [`<script>${parts.script}</script>`] : []),
    "</body>",
    "</html>",
  ].join("\n");
}

/** The id of the element a panel document's runtime renders into. */
export const PANEL_ROOT_ID = "inf-panel-root";
/** The id of the JSON block a panel document carries its runtime's config in. */
export const PANEL_CONFIG_ID = "inf-panel-config";

/** What the runtime reads out of a panel document: the config plus its panel module's URL. */
export type PanelDocumentConfig = PanelFrameConfig & { module: string };

export type PanelDocumentParts = {
  csp: string;
  theme: FrameTheme;
  title: string;
  style: string;
  /** The import map's text: its `integrity` pins every module the document may load. */
  importMap: string;
  config: PanelDocumentConfig;
  /** The boot module's own pin, for its script element's `integrity`. */
  bootIntegrity: string;
  /** The language the document speaks, the app's own unless named. */
  language?: string;
};

/** JSON text safe inside a `<script>` element: nothing in it can close the element. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/**
 * Assembles one panel document (the frame realm). Pure. The bridge is the
 * first script, as in every frame, so `ready` still marks the document's
 * birth; the import map comes before any module; the config is data (a
 * JSON block, which no policy runs); and the one module script is the lib's
 * boot, which reads the config and renders the panel into the root.
 */
export function buildPanelDocument(parts: PanelDocumentParts): string {
  const theme = escapeAttribute(parts.theme);
  return [
    "<!doctype html>",
    `<html ${languageAttributes(parts.language)} data-theme="${theme}">`,
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(parts.csp)}">`,
    '<meta charset="utf-8">',
    `<title>${escapeAttribute(parts.title)}</title>`,
    `<style>${parts.style}</style>`,
    `<script>${FRAME_BRIDGE_SCRIPT}</script>`,
    `<script type="importmap">${parts.importMap}</script>`,
    `<script type="application/json" id="${PANEL_CONFIG_ID}">${scriptSafeJson(parts.config)}</script>`,
    `<script type="module" src="${frameLibUrl(FRAME_LIB_BOOT)}" integrity="${escapeAttribute(parts.bootIntegrity)}"></script>`,
    "</head>",
    `<body data-theme="${theme}">`,
    `<div id="${PANEL_ROOT_ID}"></div>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * The action a page of a panel with background work (`config.server`)
 * calls its `invoke` through: `{ action, input }`, answered with what the
 * action returned or refused with its error's words. The host declares it
 * only on such a page, and runs it through the panel's own background work,
 * never in the window (INF-2205 piece C).
 */
export const PANEL_SERVER_ACTION = "server.invoke";

/**
 * The action a page of a panel calls its integrations through
 * (docs/integrations.md, "Panels"): `{ op: "list" }`, `{ op: "show", name }`
 * or `{ op: "call", name, action, input }`, answered with what every caller
 * gets. The core reads what the panel may reach from its own manifest.
 */
export const PANEL_INTEGRATIONS_ACTION = "integrations";

/**
 * The action a panel's page on its rail says how its body fared with: drawn,
 * or stopped and why (`{ state: "drawn" }`, `{ state: "stopped", why }`), for
 * the window's answer about its panels (docs/personal-panels.md, "Placed on
 * the rail"). The runtime sends it whatever the panel's source; a page that
 * was not declared it simply goes unheard.
 */
export const PANEL_BODY_ACTION = "panel.body";

/** What a panel's own page says of its body; the window checks it (`panelActions.ts`). */
export type PanelBodySaid = { state: "drawn" } | { state: "stopped"; why: string };
