import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import {
  CORE_INVOKE_CHANNELS,
  CORE_PUSH_CHANNELS,
  CUSTOM_API_SIGN_INS_SINCE,
  FORGE_SIGN_INS_SINCE,
  HOST_INVOKE_CHANNELS,
  PLACED_WORK_SINCE,
  PROTOCOL_MAJORS_BEHIND,
  PROTOCOL_VERSION,
  parseInvokeRequest,
  SIGN_INS_SINCE,
  WORK_DOWNLOAD_SINCE,
  WORK_UPDATE_SINCE,
} from "./ipc";
import {
  CONTRACT_FILE,
  type PublishedContract,
  renderPublishedContract,
} from "./publishedContract";
import { resourceOrders } from "./resources";
import { SIGN_IN_ORDER_CHANNELS } from "./signIns";
import {
  BROWSER_ORDER_CHANNELS,
  DOWNLOAD_ORDER_CHANNELS,
  downloadOrders,
  UPDATE_ORDER_CHANNELS,
  WORK_ORDER_CHANNELS,
  WORK_PROGRESS_ORDER,
} from "./work";

/**
 * The published contract (docs/contract.md) is generated: the committed file
 * is what the contract renders today, and every shape in it is one a client
 * can validate with on its own.
 */

const committed = readFileSync(join(__dirname, "../..", CONTRACT_FILE), "utf8");
const published = JSON.parse(committed) as PublishedContract;
// A standard JSON Schema validator, as a client in any language would use:
// strict about the schemas, with formats as annotations, as the dialect says.
const ajv = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
const requestOf = (channel: string) => {
  const shape = published.requests[channel];
  if (!shape) throw new Error(`${channel} is not published`);
  return shape;
};
const validator = (schema: unknown) => {
  const validate = ajv.compile(schema as object);
  return { safeParse: (value: unknown) => ({ success: validate(value) }) };
};

// Every shape the file publishes, by where it sits in the file.
const pairsOf = (
  section: string,
  requests: Record<string, { request: unknown; response: unknown }>,
) =>
  Object.entries(requests).flatMap(([channel, shape]): [string, unknown][] => [
    [`${section}["${channel}"].request`, shape.request],
    [`${section}["${channel}"].response`, shape.response],
  ]);
const shapes: [string, unknown][] = [
  ...pairsOf("requests", published.requests),
  ...Object.entries(published.pushes).map(([channel, shape]): [string, unknown] => [
    `pushes["${channel}"].payload`,
    shape.payload,
  ]),
  ...pairsOf("orders.requests", published.orders.requests),
  ...pairsOf("signInOrders.requests", published.signInOrders.requests),
  ...pairsOf("updateOrders.requests", published.updateOrders.requests),
  ...pairsOf("downloadOrders.requests", published.downloadOrders.requests),
  ...pairsOf("browserOrders.requests", published.browserOrders.requests),
  ...pairsOf("resourceOrders.requests", published.resourceOrders.requests),
  ["connection.clientFrame", published.connection.clientFrame],
  ["connection.homeFrame", published.connection.homeFrame],
  ["connection.pair.request", published.connection.pair.request],
  ["connection.pair.grant", published.connection.pair.grant],
  ["connection.pair.refusal", published.connection.pair.refusal],
];
// Shapes written alike compile alike, so each one is compiled once, in a test
// of its own: one compile is what that test's budget holds, and a shape that
// does not compile is named.
const distinctShapes = new Map<string, { at: string[]; shape: unknown }>();
for (const [at, shape] of shapes) {
  const key = JSON.stringify(shape);
  const alike = distinctShapes.get(key);
  if (alike) alike.at.push(at);
  else distinctShapes.set(key, { at: [at], shape });
}

describe("the published contract", () => {
  it("is what the contract renders today", () => {
    expect(
      committed === renderPublishedContract(),
      `${CONTRACT_FILE} is stale: run pnpm generate:contract and commit it`,
    ).toBe(true);
  });

  it("publishes every core request and push with the version and its rule, and nothing of the shell's own", () => {
    expect(published.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(published.versionRule.majorsBehind).toBe(PROTOCOL_MAJORS_BEHIND);
    expect(Object.keys(published.requests)).toEqual(CORE_INVOKE_CHANNELS);
    expect(Object.keys(published.pushes)).toEqual(CORE_PUSH_CHANNELS);
    for (const channel of HOST_INVOKE_CHANNELS)
      expect(published.requests).not.toHaveProperty(channel);
    expect(published.requests["inf:cards:act"]).toMatchObject({ effect: "change", reach: "views" });
    expect(published.requests["inf:feed:recent"]).toMatchObject({ effect: "read", reach: "views" });
    expect(published.requests["inf:devices:invite"]).toMatchObject({ reach: "home" });
    expect(published.requests["inf:work:report"]).toMatchObject({
      effect: "change",
      reach: "work",
    });
    expect(Object.keys(published.orders.requests)).toEqual(WORK_ORDER_CHANNELS);
    expect(published.orders.since).toBe(PLACED_WORK_SINCE);
    expect(Object.keys(published.signInOrders.requests)).toEqual(SIGN_IN_ORDER_CHANNELS);
    expect(published.signInOrders.since).toBe(SIGN_INS_SINCE);
    expect(published.signInOrders.forgesSince).toBe(FORGE_SIGN_INS_SINCE);
    expect(published.signInOrders.customSince).toBe(CUSTOM_API_SIGN_INS_SINCE);
    expect(Object.keys(published.updateOrders.requests)).toEqual(UPDATE_ORDER_CHANNELS);
    expect(published.updateOrders.since).toBe(WORK_UPDATE_SINCE);
    expect(Object.keys(published.downloadOrders.requests)).toEqual(DOWNLOAD_ORDER_CHANNELS);
    expect(published.downloadOrders.since).toBe(WORK_DOWNLOAD_SINCE);
  });

  describe("gives a standard validator a schema for every shape, on its own", () => {
    it("reads a shape from every request, push, order and frame", () => {
      expect(shapes).toHaveLength(
        2 * CORE_INVOKE_CHANNELS.length +
          CORE_PUSH_CHANNELS.length +
          2 * WORK_ORDER_CHANNELS.length +
          2 * SIGN_IN_ORDER_CHANNELS.length +
          2 * UPDATE_ORDER_CHANNELS.length +
          2 * DOWNLOAD_ORDER_CHANNELS.length +
          2 * BROWSER_ORDER_CHANNELS.length +
          2 * Object.keys(resourceOrders).length +
          5,
      );
    });

    for (const { at, shape } of distinctShapes.values()) {
      const alike = at.length > 1 ? ` and ${at.length - 1} alike` : "";
      it(`compiles ${at[0]}${alike}`, () => {
        expect(() => validator(shape)).not.toThrow();
      });
    }
  });

  it("admits a request as the home does", () => {
    // Each argument list is held to the counts the home holds it to.
    const cases = [
      ["inf:cards:act", ["card-1", "approve", "chrome"], true],
      ["inf:cards:act", ["card-1", "approve", "chrome", { gesture: 1 }, null], true],
      ["inf:cards:act", ["card-1"], false],
      ["inf:cards:act", ["card-1", "approve", "chrome", 1, 2, 3], false],
      ["inf:cards:act", ["card-1", "approve", "tap"], false],
      ["inf:feed:recent", [], true],
      ["inf:feed:recent", ["more"], false],
      ["inf:cards:close", ["card-1"], true],
    ] as const;
    for (const [channel, args, admitted] of cases) {
      const home = (() => {
        try {
          parseInvokeRequest(channel, args);
          return true;
        } catch {
          return false;
        }
      })();
      expect([channel, args, home]).toEqual([channel, args, admitted]);
      const byFile = validator(requestOf(channel).request).safeParse(args).success;
      expect([channel, args, byFile]).toEqual([channel, args, admitted]);
    }
  });

  it("publishes what the home sends open to a field a later minor adds", () => {
    const home = validator(published.connection.homeFrame);
    const welcome = {
      t: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "e",
      seq: 0,
      catchUp: "reload",
      access: "full",
    };
    expect(home.safeParse(welcome).success).toBe(true);
    expect(home.safeParse({ ...welcome, addedLater: true }).success).toBe(true);
    const { access: _access, ...withoutAccess } = welcome;
    expect(home.safeParse(withoutAccess).success).toBe(false);

    const line = validator(requestOf("inf:feed:recent").response);
    expect(line.safeParse([{ kind: "ok", text: "Done", at: 1, addedLater: 2 }]).success).toBe(true);
    expect(line.safeParse([{ kind: "ok", at: 1 }]).success).toBe(false);

    // The home's own request to a computer that runs work, too.
    const home_ = validator(published.connection.homeFrame);
    const invoke = { t: "invoke", id: 7, channel: "inf:session:roster", args: [] };
    expect(home_.safeParse(invoke).success).toBe(true);
    const roster = validator(published.orders.requests["inf:session:roster"]?.request);
    expect(roster.safeParse([]).success).toBe(true);
    const prompt = validator(published.orders.requests["inf:session:prompt"]?.request);
    const order = { orderId: "rows:1", task: "t1", text: "Go." };
    expect(prompt.safeParse([{ ...order, addedLater: true }]).success).toBe(true);
    expect(prompt.safeParse([{ task: "t1", text: "Go." }]).success).toBe(false);
  });

  // INF-369 N3: the progress answer's shape never changes across majors, so a
  // home following a download reads a state a later computer adds, as under way.
  it("reads a download's progress with a state a later computer adds, as this home and the file both do", () => {
    const later = { received: 104_857_600, total: 420_615_960, state: "resuming" };
    expect(downloadOrders[WORK_PROGRESS_ORDER].response.safeParse(later).success).toBe(true);
    const progress = validator(published.downloadOrders.requests[WORK_PROGRESS_ORDER]?.response);
    expect(progress.safeParse(later).success).toBe(true);
    expect(progress.safeParse({ received: 104_857_600 }).success).toBe(false);
  });

  it("lets a computer that runs work answer the home's request with the client frame", () => {
    const client = validator(published.connection.clientFrame);
    expect(client.safeParse({ t: "result", id: 7, ok: true, value: { turn: 1 } }).success).toBe(
      true,
    );
    expect(client.safeParse({ t: "result", id: 7, ok: false, error: "No." }).success).toBe(true);
    expect(client.safeParse({ t: "result", id: 7, ok: false }).success).toBe(false);
  });
});
