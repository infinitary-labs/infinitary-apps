import { z } from "zod";
import {
  panelIntegrationsRequestSchema,
  panelIntegrationsResponseSchema,
  personalIdSchema,
  personalInvokeOptionsSchema,
  personalInvokeResultSchema,
  personalSnapshotSchema,
  personalStoreRequestSchema,
  personalStoreResponseSchema,
} from "../personal/manifest";
import { panelMountsSchema } from "../personal/mounts";
import {
  panelFilesRequestSchema,
  panelFilesSchema,
  panelLibraryRequestSchema,
  panelLibrarySchema,
} from "../personal/panelFiles";
import { mediatedFetchCallSchema, mediatedFetchResultSchema } from "../plugins/fetch";
import { frameMountRequestSchema, frameMountSchema } from "../plugins/frameDocument";
import { actionNameSchema } from "../plugins/manifest";
import { sqlAnswerSchema, sqlRequestSchema } from "../sql";
import { type ChannelDeclaration, okSchema } from "./common";

/**
 * Added panels and their data, SQL, and the frames that draw them. A panel
 * shows the same in every window (docs/view.md, "Panels in every window"),
 * so a window on another computer asks what the window on the first mate's
 * own computer asks, and the panel's own code still runs once, there.
 */
export const panelChannels = {
  "inf:plugins:fetch": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([mediatedFetchCallSchema]),
    response: mediatedFetchResultSchema,
  },
  // The record, through SQL (plugin data surface, Phase B; src/shared/sql.ts):
  // one read-only query over the published views the asking plugin was
  // granted. The host adds the grant (`views`); the core's query process
  // runs it under the caps and answers rows or a refusal code.
  "inf:sql:query": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([sqlRequestSchema]),
    response: sqlAnswerSchema,
  },
  // Personal extensions (talk-to-personalize Step 2, docs/ui-plugins.md
  // "Personal extensions"): the snapshot the renderer mounts from, one
  // action call into an extension's `server.ts`, and the extension store's
  // four operations on one channel.
  "inf:plugins:personal:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: personalSnapshotSchema,
  },
  // A panel's built files, which the window that draws it reads once and
  // serves to its frame by their hashes (docs/ui-plugins.md, "The frame
  // realm"): answered only for a panel the first mate serves from that
  // source at exactly that version, and a draft only to a window on the
  // first mate's own computer.
  "inf:plugins:files": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([panelFilesRequestSchema]),
    response: panelFilesSchema,
  },
  // The frame realm's library, for a view that does not carry this
  // computer's own build, as a phone never does (docs/view.md, "Panels on
  // the phone"): answered only at this computer's version, so a panel's
  // files and the library they import always match.
  "inf:plugins:library": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([panelLibraryRequestSchema]),
    response: panelLibrarySchema,
  },
  // What the window did with each panel (docs/personal-panels.md, "Placed
  // on the rail"): drawn, refused and why, sent whenever it changes.
  "inf:plugins:personal:mounts": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([panelMountsSchema]),
    response: okSchema,
  },
  "inf:plugins:invoke": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      personalIdSchema,
      z.string().min(1).max(64),
      z.unknown().optional(),
      personalInvokeOptionsSchema.optional(),
    ]),
    response: personalInvokeResultSchema,
  },
  "inf:plugins:db": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([personalStoreRequestSchema]),
    response: personalStoreResponseSchema,
  },
  // The captain's Retry on a panel whose background work the app stopped
  // (INF-2205 piece B): the stop goes and the panel starts again. False when
  // nothing of that panel was stopped.
  "inf:plugins:retry": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([personalIdSchema, personalInvokeOptionsSchema.optional()]),
    response: z.boolean(),
  },
  // The captain's Update panel on a panel whose background work the app
  // refused for an older panel API (INF-2470): the first mate is told and
  // starts the update. False when nothing was told: the panel is not
  // refused, is being built, or was asked already.
  "inf:plugins:update": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([personalIdSchema]),
    response: z.boolean(),
  },
  // A panel drawing's call on its integrations (docs/integrations.md,
  // "Panels"): list, show or call, over only what its own manifest names,
  // with the answer every caller gets. The core reads the panel's
  // declarations itself; the request names only the panel and the verb.
  "inf:plugins:integrations": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      personalIdSchema,
      panelIntegrationsRequestSchema,
      personalInvokeOptionsSchema.optional(),
    ]),
    response: panelIntegrationsResponseSchema,
  },
  // A panel's change to one app setting on the captain's own press in it
  // (docs/ui-plugins.md, "Changing settings"): the core reads the panel's
  // grant again, builds the request as the first mate's action line does,
  // and runs it as the captain, naming the panel on Activity. Only this
  // computer's own window asks it: a window elsewhere keeps its own look.
  "inf:plugins:settings:change": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([personalIdSchema, actionNameSchema, z.record(z.string(), z.unknown())]),
    response: z.discriminatedUnion("ok", [
      okSchema,
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // The captain's Ask again on a panel's integration call that waits on
  // the captain's approval card or that the captain turned down: the card shows again, or a
  // new one goes up. False when that panel has no such ask.
  "inf:plugins:ask-again": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([personalIdSchema, z.string().min(1).max(200), z.string().min(1).max(200)]),
    response: z.boolean(),
  },
  // The frame vehicle (phase 1): the shell serves a template document over
  // its own scheme and hands back where the iframe loads it from. A host
  // without a desktop frame would answer with its own vehicle.
  "inf:frames:mount": {
    effect: "change",
    surface: "host",
    request: z.tuple([frameMountRequestSchema]),
    response: frameMountSchema,
  },
  "inf:frames:unmount": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // The frame watchdog's question to the main process, which every message
  // between the window and a frame passes through: an answer that changes
  // nothing says the main process is running (INF-935).
  "inf:frames:alive": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
} as const satisfies Record<string, ChannelDeclaration>;
