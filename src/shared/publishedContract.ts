import { z } from "zod";
import {
  CONNECTION_CLOSE,
  CONNECTION_MAX_FRAME_BYTES,
  CONNECTION_PATH,
  CONNECTION_PORT,
  clientFrameSchema,
  FETCH_APP_PATH,
  FETCH_APP_REFUSAL_STATUS,
  fetchAppRefusalSchema,
  fetchAppRequestSchema,
  homeFrameSchema,
  PAIR_BODY_MAX_BYTES,
  PAIR_PATH,
  PAIR_REFUSAL_STATUS,
  pairGrantSchema,
  pairRefusalSchema,
  pairRequestSchema,
} from "./connection";
import {
  CUSTOM_API_SIGN_INS_SINCE,
  FORGE_SIGN_INS_SINCE,
  PLACED_SEED_SINCE,
  PLACED_WORK_SINCE,
  SIGN_INS_SINCE,
  TASK_BROWSERS_THERE_SINCE,
  WORK_DOWNLOAD_SINCE,
  WORK_UPDATE_SINCE,
} from "./contractFeatures";
import { FILE_ORDER_CHANNELS, fileOrders } from "./files";
import { HOME_MOVE_CHANGE, HOME_MOVE_ORDER_CHANNELS, homeMoveOrders } from "./homeMove";
import {
  CORE_INVOKE_CHANNELS,
  CORE_PUSH_CHANNELS,
  HOME_CAPABILITIES,
  invokeContract,
  PROTOCOL_MAJORS_BEHIND,
  PROTOCOL_VERSION,
  pushContract,
  VIEW_FLOOR,
} from "./ipc";
import { VIEW_OPEN_LISTS } from "./openLists";
import { RESOURCE_OBSERVATIONS_SINCE, RESOURCE_ORDER, resourceOrders } from "./resources";
import { SIGN_IN_ORDER_CHANNELS, signInOrders } from "./signIns";
import { STANDBY_CHANGE, STANDBY_ORDER_CHANNELS, standbyOrders } from "./standby";
import {
  COPY_LINK_FRAME_BYTES,
  COPY_LINK_PATH,
  COPY_LINK_PORT,
  COPY_ORDER_CHANNELS,
  copyLinkFrameSchema,
  copyOrders,
  STANDBY_PEERS_CHANGE,
  STANDBY_PEERS_ORDER_CHANNELS,
  standbyPeersOrders,
} from "./standbyPeers";
import {
  DOWNLOAD_ORDER_CHANNELS,
  downloadOrders,
  SOURCE_BUILDS_CHANGE,
  SOURCE_ORDER_CHANNELS,
  sourceOrders,
  UPDATE_ORDER_CHANNELS,
  updateOrders,
  WORK_ORDER_CHANNELS,
  workOrders,
} from "./work";
import { BROWSER_ORDER_CHANNELS, browserOrders } from "./workBrowsers";

/**
 * The published contract (docs/contract.md): every core request and push of
 * `src/shared/ipc.ts`, the orders a home asks a computer that runs work
 * (`src/shared/work.ts`, `src/shared/workBrowsers.ts`, `src/shared/signIns.ts`), and the connection's envelope around them
 * (`src/shared/connection.ts`), as JSON Schema, with the version and the
 * version rule. `scripts/generate-contract.ts` writes it to
 * docs/contract.json, and `publishedContract.test.ts` fails when that file
 * no longer matches, so the file is generated and never edited by hand.
 *
 * A client writes against this file alone. What a client sends is published
 * as the home admits it. What the home sends is published open - a field the
 * file does not list is allowed - because the version rule lets a minor add
 * one, and a client ignores what it does not know.
 */

export const CONTRACT_FILE = "docs/contract.json";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

type JsonSchema = Record<string, unknown>;

/** What the home admits from a client. */
function sent(what: string, schema: z.ZodType): JsonSchema {
  return publish(what, schema, "input", false);
}

/** What the home answers or pushes: open to fields a later minor adds. */
function received(what: string, schema: z.ZodType): JsonSchema {
  return publish(what, schema, "output", true);
}

function publish(what: string, schema: z.ZodType, io: "input" | "output", open: boolean) {
  let json: JsonSchema;
  try {
    json = z.toJSONSchema(schema, {
      io,
      override: ({ zodSchema, jsonSchema }) => {
        if (open && jsonSchema.additionalProperties === false)
          delete jsonSchema.additionalProperties;
        const def = zodSchema._zod.def;
        if (def.type === "tuple" && !(def as z.core.$ZodTupleDef).rest)
          boundTuple((def as z.core.$ZodTupleDef).items, jsonSchema, io);
      },
    }) as JsonSchema;
  } catch (error) {
    throw new Error(
      `${what} cannot be published: ${(error as Error).message}. A core shape must be expressible as JSON Schema (docs/contract.md).`,
    );
  }
  // The dialect is named once, for the whole file.
  delete json.$schema;
  return oneTypeEach(json) as JsonSchema;
}

// Keywords whose values are data, not schemas: a "type" inside them is a value.
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
// Keywords whose keys are names a shape chose, such as a field called "default".
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);

/**
 * zod folds a union of bare types into one `type` list, after overrides run.
 * A strict validator, as a client would use, refuses a `type` list wider than
 * one type and null (Ajv's strictTypes), so the contract spells every union
 * of types as anyOf, one type to a branch, at the place `type` stood.
 */
function oneTypeEach(node: unknown, names = false): unknown {
  if (Array.isArray(node)) return node.map((item) => oneTypeEach(item));
  if (!node || typeof node !== "object") return node;
  const spelled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (names) spelled[key] = oneTypeEach(value);
    else if (key === "type" && Array.isArray(value))
      spelled.anyOf = value.map((type) => ({ type }));
    else if (DATA_KEYWORDS.has(key)) spelled[key] = value;
    else spelled[key] = oneTypeEach(value, NAME_MAPS.has(key));
  }
  return spelled;
}

/**
 * A list of arguments is published with the counts the home holds it to,
 * which zod leaves out: up to the last element that may not be left off,
 * and no more than it lists. Without them JSON Schema would admit any count.
 */
function boundTuple(
  items: readonly z.core.SomeType[],
  jsonSchema: Record<string, unknown>,
  io: "input" | "output",
) {
  const optional = io === "input" ? "optin" : "optout";
  let required = items.length;
  while (required > 0 && items[required - 1]?._zod[optional] === "optional") required -= 1;
  if (required > 0) jsonSchema.minItems = required;
  // An empty list has no prefix to name: JSON Schema wants one item at least.
  if (items.length === 0) {
    delete jsonSchema.prefixItems;
    jsonSchema.maxItems = 0;
  } else jsonSchema.items = false;
}

export const VERSION_RULE = {
  majorsBehind: PROTOCOL_MAJORS_BEHIND,
  viewFloor: VIEW_FLOOR,
  minor:
    "Additive: a new request, a new push, a new optional field or a new capability. Nothing a client already sends or reads changes meaning.",
  major:
    "Anything a client written against an older version could not survive: a request, push or field removed or renamed, a field made required, or a meaning changed.",
  window:
    "A home answers every request of a computer that runs work only on its own major or one of the majorsBehind before it. A view (hello as view) changes things from the home's viewFloor up to the home's major, and on an older home when the viewFloor its own hello says reaches that home's major. A computer viewing whose hello says no viewFloor is answered as work is; a phone (system ios) that says none is measured against the home's viewFloor. A client outside its window is answered its reads (effect read) and sent every push, and each change (effect change) is refused until the older side is updated. The welcome's access says which the client got.",
  reading:
    "A client ignores fields, pushes and capabilities it does not know, so what the home sends is published open. A value the home sends from one of the openLists that the client's file does not list is read as that list's unknown. The home ignores envelope fields it does not know; a request's arguments are read as published.",
  // The closed sets a view reads that a newer home may add to (src/shared/openLists.ts).
  openLists: VIEW_OPEN_LISTS.map(({ list, unknown }) => ({ members: [...list.options], unknown })),
  refusals:
    "The home checks more than these shapes can say, such as sizes in bytes and rules across fields. Its refusal comes back as the result's error.",
} as const;

/** The whole published contract, as the object docs/contract.json holds. */
export function publishedContract() {
  return {
    title: "Infinitary client contract",
    generated: `Generated from src/shared/ipc.ts, src/shared/work.ts and src/shared/connection.ts by scripts/generate-contract.ts. Do not edit; run pnpm generate:contract.`,
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    protocolVersion: PROTOCOL_VERSION,
    versionRule: VERSION_RULE,
    capabilities: [...HOME_CAPABILITIES],
    connection: {
      port: CONNECTION_PORT,
      path: CONNECTION_PATH,
      maxFrameBytes: CONNECTION_MAX_FRAME_BYTES,
      close: CONNECTION_CLOSE,
      clientFrame: sent("The client frame", clientFrameSchema),
      homeFrame: received("The home frame", homeFrameSchema),
      pair: {
        path: PAIR_PATH,
        maxBodyBytes: PAIR_BODY_MAX_BYTES,
        request: sent("The pair request", pairRequestSchema),
        grant: received("The pair grant", pairGrantSchema),
        refusal: received("The pair refusal", pairRefusalSchema),
        refusalStatus: PAIR_REFUSAL_STATUS,
      },
      // Where a command on another Mac gets Firstmate with its link's code;
      // the answer is a gzipped tar of the app's one bundle.
      fetchApp: {
        path: FETCH_APP_PATH,
        maxBodyBytes: PAIR_BODY_MAX_BYTES,
        request: sent("The request for Infinitary", fetchAppRequestSchema),
        refusal: received("The refusal of Infinitary", fetchAppRefusalSchema),
        refusalStatus: FETCH_APP_REFUSAL_STATUS,
      },
    },
    requests: Object.fromEntries(
      CORE_INVOKE_CHANNELS.map((channel) => {
        const declared = invokeContract[channel];
        return [
          channel,
          {
            effect: declared.effect,
            reach: declared.reach,
            request: sent(`The ${channel} request`, declared.request),
            response: received(`The ${channel} response`, declared.response),
          },
        ];
      }),
    ),
    pushes: Object.fromEntries(
      CORE_PUSH_CHANNELS.map((channel) => [
        channel,
        { payload: received(`The ${channel} push`, pushContract[channel].payload) },
      ]),
    ),
    // What a home asks a computer that runs work, from `since` on. The home
    // sends the request, so it is published open; the computer's answer as
    // the home reads it.
    orders: {
      since: PLACED_WORK_SINCE,
      // The seed order and a prepare that names a seed, from this version on.
      seedSince: PLACED_SEED_SINCE,
      requests: Object.fromEntries(
        WORK_ORDER_CHANNELS.map((channel) => {
          const declared = workOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks a computer that runs work about its own sign-ins
    // (`src/shared/signIns.ts`), from `since` on, published the same way.
    signInOrders: {
      since: SIGN_INS_SINCE,
      // The orders about its sign-in where projects live, and Claude's
      // pasted code, from this version on.
      forgesSince: FORGE_SIGN_INS_SINCE,
      customSince: CUSTOM_API_SIGN_INS_SINCE,
      requests: Object.fromEntries(
        SIGN_IN_ORDER_CHANNELS.map((channel) => {
          const declared = signInOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks a computer that runs work about its tasks' own
    // browsers there (`src/shared/workBrowsers.ts`, docs/task-browser.md "On another
    // computer"), from `since` on, published the same way.
    browserOrders: {
      since: TASK_BROWSERS_THERE_SINCE,
      requests: Object.fromEntries(
        BROWSER_ORDER_CHANNELS.map((channel) => {
          const declared = browserOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks a computer that runs work about that computer's own
    // files, for a crewmate on another computer (`src/shared/files.ts`,
    // docs/files.md), on the current work major, published the same way.
    fileOrders: {
      requests: Object.fromEntries(
        FILE_ORDER_CHANNELS.map((channel) => {
          const declared = fileOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks the computer it moves to (`src/shared/homeMove.ts`,
    // docs/devices.md, "Moving the first mate"), from the `home-move` change on.
    homeMoveOrders: {
      change: HOME_MOVE_CHANGE,
      requests: Object.fromEntries(
        HOME_MOVE_ORDER_CHANNELS.map((channel) => {
          const declared = homeMoveOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks a computer that keeps a copy of its record
    // (`src/shared/standby.ts`, docs/devices.md, "Keeping a copy on another
    // computer"), from the `standby-copy` change on.
    standbyOrders: {
      change: STANDBY_CHANGE,
      requests: Object.fromEntries(
        STANDBY_ORDER_CHANNELS.map((channel) => {
          const declared = standbyOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // What a home asks a computer that keeps a copy about the other copies
    // (`src/shared/standbyPeers.ts`, docs/devices.md, "Copies that reach each
    // other"), from the `standby-peers` change on.
    standbyPeersOrders: {
      change: STANDBY_PEERS_CHANGE,
      requests: Object.fromEntries(
        STANDBY_PEERS_ORDER_CHANNELS.map((channel) => {
          const declared = standbyPeersOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // The link between two computers that keep a copy, from the
    // `standby-peers` change on: pinned TLS both ways, each side's key the one
    // it joined with, and these frames and orders either way.
    copyLink: {
      change: STANDBY_PEERS_CHANGE,
      port: COPY_LINK_PORT,
      path: COPY_LINK_PATH,
      maxFrameBytes: COPY_LINK_FRAME_BYTES,
      frame: received("A frame between two copies", copyLinkFrameSchema),
      requests: Object.fromEntries(
        COPY_ORDER_CHANNELS.map((channel) => {
          const declared = copyOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    resourceOrders: {
      since: RESOURCE_OBSERVATIONS_SINCE,
      requests: Object.fromEntries(
        Object.entries(resourceOrders).map(([channel, declared]) => [
          channel,
          {
            effect: declared.effect,
            request: received(`The ${channel} order`, declared.request),
            response: sent(`The ${channel} answer`, declared.response),
          },
        ]),
      ),
    },
    // The update order a home asks a computer that runs work whatever its
    // version, from `since` on (`src/shared/work.ts`): bring Firstmate there
    // to the home's own. Its name and shape never change across majors.
    updateOrders: {
      since: WORK_UPDATE_SINCE,
      requests: Object.fromEntries(
        UPDATE_ORDER_CHANNELS.map((channel) => {
          const declared = updateOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // The orders a home asks a Mac that runs work to download its update
    // itself, from `since` on (`src/shared/work.ts`): the download, and how
    // far it got. Their names and shapes never change across majors either.
    downloadOrders: {
      since: WORK_DOWNLOAD_SINCE,
      requests: Object.fromEntries(
        DOWNLOAD_ORDER_CHANNELS.map((channel) => {
          const declared = downloadOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              request: received(`The ${channel} order`, declared.request),
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
    // The order a home run from source asks a Mac that runs work to build
    // its commit (`src/shared/work.ts`), of a computer that lists the
    // `source-builds` change.
    sourceOrders: {
      change: SOURCE_BUILDS_CHANGE,
      requests: Object.fromEntries(
        SOURCE_ORDER_CHANNELS.map((channel) => {
          const declared = sourceOrders[channel];
          return [
            channel,
            {
              effect: declared.effect,
              // i18n-exempt: descriptions in the published contract, never shown
              request: received(`The ${channel} order`, declared.request),
              // i18n-exempt: descriptions in the published contract, never shown
              response: sent(`The ${channel} answer`, declared.response),
            },
          ];
        }),
      ),
    },
  };
}

export type PublishedContract = ReturnType<typeof publishedContract>;

/** The bytes of docs/contract.json. */
export function renderPublishedContract(): string {
  return `${JSON.stringify(publishedContract(), null, 2)}\n`;
}
