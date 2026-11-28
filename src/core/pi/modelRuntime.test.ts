import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  catalogRefreshesSettled,
  createCatalogRuntime,
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
  // A stand-in that never answered left its runtime's refresh waiting; the
  // closed connection ends it, and its store write lands in the test's
  // folder, so the file's cleanup waits for it (docs/testing.md).
  await catalogRefreshesSettled();
});

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

/**
 * INF-6873: an OpenCode Go account comes only from the person's own pasted
 * key. Pi's OpenCode Go key auth falls back to OPENCODE_API_KEY when nothing
 * is stored, so a variable set on the computer must sign nothing in.
 */
describe("OpenCode Go's key", () => {
  const VARIABLE = "OPENCODE_API_KEY";
  let saved: string | undefined;

  function storeWith(entries: Record<string, unknown>) {
    const dir = scratchDir("infinitary-model-runtime-opencode-");
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify(entries), { mode: 0o600 });
    return { authPath, modelsPath: join(dir, "models.json") };
  }

  function servesOpenCodeGo(runtime: Awaited<ReturnType<typeof createModelRuntime>>): boolean {
    return runtime.getAvailableSnapshot().some((model) => model.provider === "opencode-go");
  }

  afterEach(() => {
    if (saved === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = saved;
  });

  it("signs in no account, and lends no other account its models, from a key in the environment", async () => {
    saved = process.env[VARIABLE];
    process.env[VARIABLE] = "sk-from-the-environment";
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));

    const signedOut = await createModelRuntime({ ...storeWith({}), catalogBaseUrl });
    expect(signedOut.hasConfiguredAuth("opencode-go")).toBe(false);
    expect(await signedOut.getAuth("opencode-go")).toBeUndefined();
    expect(servesOpenCodeGo(signedOut)).toBe(false);

    const grok = await createModelRuntime({ ...signedInStore(), catalogBaseUrl });
    expect(grok.getAvailableSnapshot().some((model) => model.provider === "xai")).toBe(true);
    expect(servesOpenCodeGo(grok)).toBe(false);
  });

  it("answers with the account's own stored key, the environment's set or not", async () => {
    saved = process.env[VARIABLE];
    process.env[VARIABLE] = "sk-from-the-environment";
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const runtime = await createModelRuntime({
      ...storeWith({ "opencode-go": { type: "api_key", key: "sk-pasted-by-the-person" } }),
      catalogBaseUrl,
    });
    expect(runtime.hasConfiguredAuth("opencode-go")).toBe(true);
    expect((await runtime.getAuth("opencode-go"))?.auth.apiKey).toBe("sk-pasted-by-the-person");
    expect(runtime.getModel("opencode-go", "kimi-k3")).toBeDefined();
    expect(servesOpenCodeGo(runtime)).toBe(true);
  });

  it("still takes pi.dev's OpenCode Go list over the bundled one", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) =>
      status(200, JSON.stringify([{ id: "kimi-k9", name: "Kimi K9", api: "openai-completions" }]), {
        "last-modified": new Date(Date.now() + 60_000).toUTCString(),
      }),
    );
    const { runtime, refreshed } = await createWithRefresh({
      ...storeWith({ "opencode-go": { type: "api_key", key: "sk-pasted-by-the-person" } }),
      catalogBaseUrl,
    });
    await refreshed;
    const ids = runtime.getModels("opencode-go").map((model) => model.id);
    expect(ids).toContain("kimi-k9");
    expect(ids).toContain("kimi-k3");
  });
});

describe("GitHub Copilot's own list", () => {
  // Pi narrows Copilot to the model ids it stored at sign-in
  // (docs/model-lists.md), and the account lists only those at every moment.
  function copilotStore(): { authPath: string; modelsPath: string } {
    const dir = scratchDir("infinitary-model-runtime-copilot-");
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: "ghu-stored-at-sign-in",
          access: "tid-stored-at-sign-in",
          expires: Date.now() + 3_600_000,
          availableModelIds: ["claude-sonnet-5.5"],
        },
      }),
      { mode: 0o600 },
    );
    return { authPath, modelsPath: join(dir, "models.json") };
  }

  function copilotIds(runtime: Awaited<ReturnType<typeof createModelRuntime>>): string[] {
    return runtime
      .getAvailableSnapshot()
      .filter((model) => model.provider === "github-copilot")
      .map((model) => model.id);
  }

  // Registering OpenCode Go in the same runtime must not widen it again
  // before the background refresh lands.
  it("lists only the account's own Copilot models as soon as the runtime is created", async () => {
    const catalogBaseUrl = await startCatalog(({ hang }) => hang());
    const runtime = await createModelRuntime({ ...copilotStore(), catalogBaseUrl });
    expect(copilotIds(runtime)).toEqual(["claude-sonnet-5.5"]);
  });

  it("keeps listing only the account's own Copilot models while pi.dev's answer is awaited (INF-6929)", async () => {
    let asked: () => void = () => {};
    const fetching = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const catalogBaseUrl = await startCatalog(({ hang }) => {
      asked();
      hang();
    });
    const runtime = await createModelRuntime({ ...copilotStore(), catalogBaseUrl });
    // Pi asks pi.dev only once its refresh has rebuilt the model list, so
    // this read is the list served for as long as the answer takes.
    await fetching;
    expect(copilotIds(runtime)).toEqual(["claude-sonnet-5.5"]);
  });
});

/**
 * Every offered provider's account comes only from the person's own sign-in
 * in its store. Pi's key auth for these providers falls back to a variable
 * on the computer when nothing is stored, and a Windows app, or one started
 * from a terminal, keeps that variable (hostEnv.ts).
 */
describe("keys set on the computer", () => {
  const VARIABLES = {
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    "github-copilot": "COPILOT_GITHUB_TOKEN",
  } as const;
  type Guarded = keyof typeof VARIABLES;
  const GUARDED = Object.keys(VARIABLES) as Guarded[];
  // PI_OFFLINE keeps OpenRouter's key-personalized list from asking
  // openrouter.ai with a test key; the stand-in pi.dev answers the rest.
  const SET = ["PI_OFFLINE", ...Object.values(VARIABLES)];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of SET) saved.set(name, process.env[name]);
    process.env.PI_OFFLINE = "1";
    for (const provider of GUARDED) process.env[VARIABLES[provider]] = `${provider}-computer-key`;
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  function storeHolding(entries: Record<string, unknown>) {
    const dir = scratchDir("infinitary-model-runtime-computer-keys-");
    mkdirSync(dir, { recursive: true });
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify(entries), { mode: 0o600 });
    return { authPath, modelsPath: join(dir, "models.json") };
  }

  function served(runtime: Awaited<ReturnType<typeof createModelRuntime>>, provider: string) {
    return runtime.getAvailableSnapshot().filter((model) => model.provider === provider);
  }

  it.each(GUARDED)("leaves a %s account with an empty store signed out", async (provider) => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const runtime = await createModelRuntime({ ...storeHolding({}), catalogBaseUrl });
    expect(runtime.hasConfiguredAuth(provider)).toBe(false);
    expect(runtime.getProviderAuthStatus(provider)).toEqual({ configured: false });
    expect(await runtime.getAuth(provider)).toBeUndefined();
    expect(served(runtime, provider)).toEqual([]);
  });

  it("lends another provider's account none of their models or keys", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const codex = await createModelRuntime({
      ...storeHolding({
        "openai-codex": {
          type: "oauth",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 3_600_000,
          accountId: "codex-account",
        },
      }),
      catalogBaseUrl,
    });
    expect(served(codex, "openai-codex").length).toBeGreaterThan(0);
    for (const provider of GUARDED) {
      expect(served(codex, provider)).toEqual([]);
      const model = codex.getModels(provider)[0];
      expect(model).toBeDefined();
      expect(await codex.getAuth(model as NonNullable<typeof model>)).toBeUndefined();
    }
  });

  it.each(GUARDED)("answers a %s account with its own stored key", async (provider) => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const runtime = await createModelRuntime({
      ...storeHolding({ [provider]: { type: "api_key", key: `${provider}-stored-key` } }),
      catalogBaseUrl,
    });
    expect(runtime.hasConfiguredAuth(provider)).toBe(true);
    expect((await runtime.getAuth(provider))?.auth.apiKey).toBe(`${provider}-stored-key`);
    expect(served(runtime, provider).length).toBeGreaterThan(0);
    for (const other of GUARDED.filter((each) => each !== provider))
      expect(served(runtime, other)).toEqual([]);
  });

  it("answers a Kimi Code sign-in with its own token", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const runtime = await createModelRuntime({
      ...storeHolding({
        "kimi-coding": {
          type: "oauth",
          access: "kimi-signed-in-access",
          refresh: "kimi-signed-in-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
      catalogBaseUrl,
    });
    expect(runtime.isUsingOAuth("kimi-coding")).toBe(true);
    expect((await runtime.getAuth("kimi-coding"))?.auth.headers).toEqual({
      Authorization: "Bearer kimi-signed-in-access",
    });
  });

  it("answers a Copilot sign-in with its own token", async () => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "offline"));
    const runtime = await createModelRuntime({
      ...storeHolding({
        "github-copilot": {
          type: "oauth",
          access: "copilot-signed-in-access",
          refresh: "copilot-signed-in-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
      catalogBaseUrl,
    });
    expect(runtime.isUsingOAuth("github-copilot")).toBe(true);
    expect((await runtime.getAuth("github-copilot"))?.auth.apiKey).toBe("copilot-signed-in-access");
    expect(served(runtime, "github-copilot").length).toBeGreaterThan(0);
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

// INF-7139's approved plan, part 1: Pi's coding agent adds a google-ai-plan
// provider signed in through Pi's own Google client to every runtime it
// creates, and no Infinitary runtime may offer that sign-in.
describe("Pi's Google AI plan sign-in", () => {
  type Runtime = Awaited<ReturnType<typeof createModelRuntime>>;
  const GOOGLE_AI_PLAN = "google-ai-plan";

  async function attemptGoogleSignIn(runtime: Runtime): Promise<{
    outcome: PromiseSettledResult<unknown>;
    asked: string[];
  }> {
    const asked: string[] = [];
    const outcome = (
      await Promise.allSettled([
        runtime.login(GOOGLE_AI_PLAN, "oauth", {
          // A sign-in that did start would wait on its browser page; the
          // bound ends it after the page was asked for.
          signal: AbortSignal.timeout(3_000),
          prompt: (prompt) => {
            asked.push(`prompt: ${prompt.message}`);
            return Promise.reject(new Error("No one answers in a test."));
          },
          notify: (event) => {
            asked.push(event.type === "auth_url" ? `page: ${event.url}` : `notify: ${event.type}`);
          },
        }),
      ])
    )[0];
    return { outcome, asked };
  }

  function emptyStore(): { authPath: string; modelsPath: string } {
    const dir = scratchDir("infinitary-model-runtime-google-");
    mkdirSync(dir, { recursive: true });
    return { authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") };
  }

  it.each([
    ["an account's", async () => ({ ...signedInStore() })],
    ["a connection's", async () => ({ ...emptyStore(), connectionProvider: "custom-fixture" })],
    ["a Bedrock account's", async () => ({ ...emptyStore(), bedrockAccount: true })],
  ])("is not offered by %s runtime", async (_kind, options) => {
    const catalogBaseUrl = await startCatalog(({ status }) => status(500, "nope"));
    const runtime = await createModelRuntime({ ...(await options()), catalogBaseUrl });
    const { outcome, asked } = await attemptGoogleSignIn(runtime);
    expect(outcome.status).toBe("rejected");
    expect(asked).toEqual([]);
  });

  it("is not offered by the catalog runtime", async () => {
    const dir = scratchDir("infinitary-model-runtime-google-catalog-");
    mkdirSync(dir, { recursive: true });
    const { runtime } = await createCatalogRuntime({
      modelsStorePath: join(dir, "models-store.json"),
    });
    const { outcome, asked } = await attemptGoogleSignIn(runtime);
    expect(outcome.status).toBe("rejected");
    expect(asked).toEqual([]);
  });
});
