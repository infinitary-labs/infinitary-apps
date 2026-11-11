import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  catalogRefreshesSettled,
  createModelRuntime,
  MODEL_REFRESH_TIMEOUT_MS,
  modelLookup,
} from "./modelRuntime";

/**
 * The captain's hard requirements on the live pi.dev catalog: every failure
 * mode falls back to pi-ai's bundled static catalog and continues - no
 * error, no hang, no empty model list - and nothing waits on the fetch at
 * all: the runtime is created offline and the overlay lands in the
 * background (docs/model-lists.md). Proven here against a stand-in pi.dev,
 * not assumed from pi's overlay-over-builtin design.
 */

type Responder = (respond: {
  status: (code: number, body: string, headers?: Record<string, string>) => void;
  hang: () => void;
}) => void;

const servers: Server[] = [];

async function startCatalog(responder: Responder): Promise<string> {
  const created = createServer((_request, response) => {
    responder({
      status: (code, body, headers) => {
        response.writeHead(code, { "content-type": "application/json", ...headers });
        response.end(body);
      },
      hang: () => {
        // Never answers: the caller's bound is the only thing that ends it.
      },
    });
  });
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  servers.push(created);
  return `http://127.0.0.1:${(created.address() as AddressInfo).port}`;
}

afterEach(async () => {
  const running = servers.splice(0);
  for (const each of running) {
    each.closeAllConnections();
    await new Promise<void>((resolve) => each.close(() => resolve()));
  }
});

/** Creates a runtime and a promise for its background refresh settling. */
async function createWithRefresh(
  options: Parameters<typeof createModelRuntime>[0],
): Promise<{ runtime: Awaited<ReturnType<typeof createModelRuntime>>; refreshed: Promise<void> }> {
  let settle: () => void = () => {};
  const refreshed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const runtime = await createModelRuntime({ ...options, onCatalogRefreshed: () => settle() });
  return { runtime, refreshed };
}

/** A store shaped like the vault's: one signed-in xAI account. */
function signedInStore(): { authPath: string; modelsPath: string } {
  const dir = scratchDir("infinitary-model-runtime-");
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ xai: { type: "api_key", key: "fake-key" } }), {
    mode: 0o600,
  });
  return { authPath, modelsPath: join(dir, "models.json") };
}

/** The bundled xAI catalog pi-ai ships, which the fallback must preserve. */
function staticGrokIds(runtime: {
  getModels: (provider?: string) => readonly { id: string }[];
}): string[] {
  return runtime.getModels("xai").map((model) => model.id);
}

/**
 * The exact defs pi.dev served the captain's dogfood install (2026-09-01):
 * grok-build-0.1 claims `reasoning: true` on the openai-responses api while
 * its thinkingLevelMap pins no level to an effort token, and grok-4.6 pins
 * real tokens.
 */
const DOGFOOD_GROK_DEFS = [
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 256000,
    thinkingLevelMap: { off: null, minimal: null },
  },
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500000,
    maxTokens: 500000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    },
  },
];

describe("createModelRuntime", () => {
  it("falls back to the static catalog when the catalog host errors", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "nope"));
    const { runtime, refreshed } = await createWithRefresh({ ...signedInStore(), catalogBaseUrl });
    await refreshed;
    expect(staticGrokIds(runtime)).toContain("grok-4.3");
    expect(runtime.getAvailableSnapshot().length).toBeGreaterThan(0);
  });

  it("falls back to the static catalog when the payload is malformed", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(200, "not json at all"));
    const { runtime, refreshed } = await createWithRefresh({ ...signedInStore(), catalogBaseUrl });
    await refreshed;
    expect(staticGrokIds(runtime)).toContain("grok-4.3");
    expect(runtime.getAvailableSnapshot().length).toBeGreaterThan(0);
  });

  it("falls back to the static catalog when the host is unreachable", async () => {
    // Bind and immediately drop the listener: the port answers nothing.
    const catalogBaseUrl = await startCatalog(({ status }) => status(200, "[]"));
    const running = servers.pop();
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    const { runtime, refreshed } = await createWithRefresh({ ...signedInStore(), catalogBaseUrl });
    await refreshed;
    expect(staticGrokIds(runtime)).toContain("grok-4.3");
    expect(runtime.getAvailableSnapshot().length).toBeGreaterThan(0);
  });

  it("publishes the live overlay over the bundled catalog once it lands", async () => {
    // Shaped like pi.dev's provider catalog: one id the bundle does not have.
    const catalogBaseUrl = await startCatalog(({ status }) =>
      status(200, JSON.stringify([{ id: "grok-9.9", name: "Grok 9.9", api: "openai-responses" }]), {
        // Pi only publishes an overlay newer than the bundled data.
        "last-modified": new Date(Date.now() + 60_000).toUTCString(),
      }),
    );
    const store = signedInStore();
    const { runtime, refreshed } = await createWithRefresh({ ...store, catalogBaseUrl });
    await refreshed;
    expect(staticGrokIds(runtime)).toContain("grok-9.9");
    expect(staticGrokIds(runtime)).toContain("grok-4.3");
    // The overlay is kept with the store: the next start - still offline,
    // still waiting on nothing - already has it.
    const unreachable = await startCatalog(({ hang }) => hang());
    const next = await createModelRuntime({ ...store, catalogBaseUrl: unreachable });
    expect(staticGrokIds(next)).toContain("grok-9.9");
  });

  it("returns at once, with the bundled list, while the fetch never answers", async () => {
    // The start-up path: account attachment awaits this create, and it must
    // not wait on pi.dev at all - not even for a bounded time.
    const catalogBaseUrl = await startCatalog(({ hang }) => hang());
    let refreshedAt: number | undefined;
    const startedAt = Date.now();
    const runtime = await createModelRuntime({
      ...signedInStore(),
      catalogBaseUrl,
      onCatalogRefreshed: () => {
        refreshedAt = Date.now();
      },
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(1_000);
    expect(refreshedAt).toBeUndefined();
    expect(staticGrokIds(runtime)).toContain("grok-4.3");
    // The picker reads this snapshot: it is full before the fetch answers.
    expect(runtime.getAvailableSnapshot().some((model) => model.provider === "xai")).toBe(true);
    expect(MODEL_REFRESH_TIMEOUT_MS).toBeGreaterThan(1_000);
  });

  it("serves an effort-less live reasoning def as non-reasoning through getModel", async () => {
    // The exact defs pi.dev served the captain's dogfood install
    // (2026-09-01): grok-build-0.1 claims `reasoning: true` on the
    // openai-responses api while its thinkingLevelMap pins no level to an
    // effort token, and xai 400s any reasoningEffort sent to it. The def
    // must come out of getModel as non-reasoning so no session ever sends
    // one; grok-4.6's map has real tokens and must stay untouched.
    const catalogBaseUrl = await startCatalog(({ status }) =>
      status(200, JSON.stringify(DOGFOOD_GROK_DEFS), {
        "last-modified": new Date(Date.now() + 60_000).toUTCString(),
      }),
    );
    const { runtime, refreshed } = await createWithRefresh({ ...signedInStore(), catalogBaseUrl });
    await refreshed;
    expect(runtime.getModel("xai", "grok-build-0.1")?.reasoning).toBe(false);
    expect(runtime.getModel("xai", "grok-4.6")?.reasoning).toBe(true);
  });

  it("modelLookup serves getModel's defs from one catalog listing per provider", async () => {
    // INF-803: the account model list resolved each listed model through
    // getModel, which rebuilds the provider's whole catalog per call; with
    // OpenRouter's catalog that blocked the main process for seconds after
    // a key sign-in. One read now lists each provider once and must still
    // serve exactly the corrected defs getModel serves.
    const catalogBaseUrl = await startCatalog(({ status }) =>
      status(200, JSON.stringify(DOGFOOD_GROK_DEFS), {
        "last-modified": new Date(Date.now() + 60_000).toUTCString(),
      }),
    );
    const { runtime, refreshed } = await createWithRefresh({ ...signedInStore(), catalogBaseUrl });
    await refreshed;
    const refs = ["xai", "openrouter"].flatMap((provider) =>
      runtime.getModels(provider).map((model) => ({ provider, id: model.id })),
    );
    expect(refs.length).toBeGreaterThan(100);
    const expected = refs.map((ref) => runtime.getModel(ref.provider, ref.id));
    const listings: (string | undefined)[] = [];
    const getModels = runtime.getModels.bind(runtime);
    runtime.getModels = (provider?: string) => {
      listings.push(provider);
      return getModels(provider);
    };
    const defOf = modelLookup(runtime);
    expect(refs.map((ref) => defOf(ref.provider, ref.id))).toEqual(expected);
    expect(defOf("xai", "grok-build-0.1")?.reasoning).toBe(false);
    expect(defOf("xai", "no-such-model")).toBeUndefined();
    expect(listings).toEqual(["xai", "openrouter"]);
  });
});

describe("catalogRefreshesSettled", () => {
  // A paused merge batch: the Codex sign-in test ended while its runtime's
  // background refresh still ran, the file's cleanup removed the test's
  // folder, and the refresh's next store write put the folder back, so the
  // unit run failed on a leftover folder. A test that removes a runtime's
  // folder waits here first (docs/testing.md), so this must not resolve
  // before the refresh's last write into it.
  it("resolves only after the background refresh's late write into the store's folder", async () => {
    const held: (() => void)[] = [];
    let released = false;
    let asked: () => void = () => {};
    const requested = new Promise<void>((resolve) => {
      asked = resolve;
    });
    // Shaped like pi.dev's provider catalog, as the overlay test serves it.
    const catalogBaseUrl = await startCatalog(({ status }) => {
      const answer = () =>
        status(
          200,
          JSON.stringify([{ id: "grok-9.9", name: "Grok 9.9", api: "openai-responses" }]),
          {
            "last-modified": new Date(Date.now() + 60_000).toUTCString(),
          },
        );
      if (released) answer();
      else held.push(answer);
      asked();
    });
    const store = signedInStore();
    const folder = dirname(store.authPath);
    await createModelRuntime({ ...store, catalogBaseUrl });
    // The refresh has read the store and waits on the catalog's answer.
    await requested;
    const settled = catalogRefreshesSettled();
    // A cleanup that does not wait removes the folder here, mid-refresh.
    rmSync(folder, { recursive: true, force: true });
    released = true;
    for (const answer of held.splice(0)) answer();
    await settled;
    // The refresh wrote the overlay after the folder was removed, putting it
    // back, and the wait above resolved only once that write had landed.
    expect(readFileSync(join(folder, "models-store.json"), "utf8")).toContain("grok-9.9");
  });
});
