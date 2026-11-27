import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CATALOG_REFRESH_EVERY_MS, createAccountStore } from "../models/accountStore";
import { appPathsFor } from "../paths";
import { AccountVault } from "./accountVault";
import { appPiAccountBackend } from "./appPiAccountBackend";
import { catalogRefreshesSettled } from "./modelRuntime";
import type { AuthInteractionBridge } from "./piAuth";

/**
 * The bug: a Codex account connected while the app keeps running listed only
 * Pi's bundled models, and GPT-6.2 Sol and Astra, which only pi.dev serves,
 * appeared after a full restart. The account's runtime is created, and runs
 * its one pi.dev refresh, before the sign-in writes a credential, and Pi
 * skips a provider's catalog without one.
 *
 * The app's own vault, Pi backend and Pi's real Codex device-code sign-in
 * run here; only the network is stood in. pi.dev answers the openai-codex
 * catalog it served on 2026-11-27, and OpenAI's sign-in answers a stand-in
 * token.
 *
 * A later Pi may bundle GPT-6.2 itself, and Pi drops an overlay older than
 * its bundle, so the catalog also carries one model only this stand-in
 * serves, under a Last-Modified no bundle reaches: that model is the guard.
 *
 * The second gap: an account connected before its provider publishes a
 * model kept the list it had until a restart, because nothing asked pi.dev,
 * or Codex for the account's own list, again while the app stayed open.
 */

const REAL_CATALOG: { id: string; name: string }[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "pidevOpenAiCodexCatalog.json"), "utf8"),
);
const PI_DEV_ONLY = "gpt-pi-dev-only-stand-in";
const CATALOG = JSON.stringify([
  ...REAL_CATALOG,
  {
    ...REAL_CATALOG.find((model) => model.id === "gpt-6.2-sol"),
    id: PI_DEV_ONLY,
    name: "pi.dev-only stand-in",
  },
]);
const CATALOG_LAST_MODIFIED = "Fri, 31 Dec 9999 23:59:59 GMT";

/** A Pro account's own Codex list as Codex answered it on 2026-11-17. */
const CODEX_LIST: { models: Record<string, unknown>[] } = JSON.parse(
  readFileSync(join(__dirname, "..", "models", "fixtures", "codexProAccountList.json"), "utf8"),
);
const PUBLISHED_LATER = "gpt-published-later-stand-in";
const BEFORE_PUBLISHING: Answers = {
  catalog: JSON.stringify(REAL_CATALOG),
  etag: '"before"',
  codexList: CODEX_LIST,
};
/** The provider published a model: pi.dev's catalog and the account's own list both name it. */
const AFTER_PUBLISHING: Answers = {
  catalog: JSON.stringify([
    ...REAL_CATALOG,
    {
      ...REAL_CATALOG.find((model) => model.id === "gpt-6.2-sol"),
      id: PUBLISHED_LATER,
      name: "Published-later stand-in",
    },
  ]),
  etag: '"after"',
  codexList: {
    models: [
      ...CODEX_LIST.models,
      {
        ...CODEX_LIST.models.find((row) => row.slug === "gpt-6.2-sol"),
        slug: PUBLISHED_LATER,
        display_name: "Published-later stand-in",
      },
    ],
  },
};

function standInToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return [
    part({ alg: "none" }),
    part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-stand-in" } }),
    "sig",
  ].join(".");
}

/**
 * What pi.dev and Codex answer at a moment: pi.dev's Codex catalog with the
 * ETag it is revalidated by, and the account's own list, which Codex serves
 * only to an account store's read.
 */
type Answers = { catalog: string; etag?: string; codexList?: unknown };

function standInNetwork(answers: () => Answers): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const json = (body: string, headers: Record<string, string> = {}) =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url.host === "pi.dev") {
      if (url.pathname !== "/api/models/providers/openai-codex")
        return new Response("not found", { status: 404 });
      const { catalog, etag } = answers();
      if (etag && new Headers(init?.headers).get("if-none-match") === etag)
        return new Response(null, { status: 304 });
      // Pi takes the overlay only when it is newer than its bundled catalog.
      return json(catalog, { "last-modified": CATALOG_LAST_MODIFIED, ...(etag ? { etag } : {}) });
    }
    const codexList = answers().codexList;
    if (url.host === "chatgpt.com" && url.pathname === "/backend-api/codex/models" && codexList)
      return json(JSON.stringify(codexList));
    if (url.host === "auth.openai.com") {
      if (url.pathname === "/api/accounts/deviceauth/usercode")
        return json(
          JSON.stringify({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: 1 }),
        );
      if (url.pathname === "/api/accounts/deviceauth/token")
        return json(JSON.stringify({ authorization_code: "code-1", code_verifier: "verifier-1" }));
      if (url.pathname === "/oauth/token")
        return json(
          JSON.stringify({
            access_token: standInToken(),
            refresh_token: "refresh-1",
            expires_in: 3600,
          }),
        );
    }
    throw new Error(`no stand-in for ${url.host}${url.pathname}`);
  }) as typeof fetch;
}

/** Picks the device-code sign-in once the new runtime's own refresh has run, as a person in the browser would. */
const deviceCodeSignIn: AuthInteractionBridge = {
  prompt: async (prompt) => {
    await catalogRefreshesSettled();
    return prompt.kind === "select"
      ? (prompt.options?.find((option) => /device/i.test(option.id))?.id ?? "")
      : "";
  },
  notify: () => {},
  openExternal: async () => {},
};

/** The Codex models the vault serves; this test connects one account. */
function codexIds(vault: AccountVault): string[] {
  return vault
    .availableModelsByAccount()
    .flatMap((row) => row.models)
    .filter((model) => model.provider === "openai-codex")
    .map((model) => model.id);
}

describe("Codex connected while the app keeps running", () => {
  afterEach(async () => {
    await catalogRefreshesSettled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lists pi.dev-only models such as GPT-6.2 Sol and Astra once the sign-in lands, and tells the home", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    vi.stubGlobal(
      "fetch",
      standInNetwork(() => ({ catalog: CATALOG })),
    );
    const paths = appPathsFor(scratchDir("infinitary-codex-connect-"));
    const told: string[][] = [];
    const vault = AccountVault.create(paths, {
      pi: appPiAccountBackend(paths.modelsPath, {}, () => told.push(codexIds(vault))),
    });
    await vault.warm();

    await vault.add("openai-codex", "oauth", deviceCodeSignIn);
    await catalogRefreshesSettled();

    expect(codexIds(vault)).toEqual(
      expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra", PI_DEV_ONLY]),
    );
    expect(told.at(-1)).toEqual(
      expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra", PI_DEV_ONLY]),
    );
  }, 30_000);

  it("lists a model its provider publishes after the account connected once the catalog pass runs, and tells the home", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    let answers = BEFORE_PUBLISHING;
    vi.stubGlobal(
      "fetch",
      standInNetwork(() => answers),
    );
    const paths = appPathsFor(scratchDir("infinitary-codex-published-"));
    const told: string[][] = [];
    const tell = () => told.push(codexIds(store.vault));
    const store = createAccountStore(paths, {
      pi: appPiAccountBackend(paths.modelsPath, {}, tell),
      packaged: false,
      claudeConfigDir: () => join(paths.userData, "claude-config"),
      rail: { protectedIds: () => [] },
      onSettled: tell,
    });
    await store.vault.warm();

    const connectedAt = Date.now();
    const account = await store.vault.add("openai-codex", "oauth", deviceCodeSignIn);
    await catalogRefreshesSettled();
    // The app reads a new account's own list once it connects.
    await store.served.refresh(account.id);
    expect(codexIds(store.vault)).toContain("gpt-6.2-sol");
    expect(codexIds(store.vault)).not.toContain(PUBLISHED_LATER);

    answers = AFTER_PUBLISHING;
    // The clock's pass comes one period after the refresh the sign-in started.
    vi.setSystemTime(connectedAt + CATALOG_REFRESH_EVERY_MS);
    await store.refreshCatalogs();
    await catalogRefreshesSettled();

    expect(codexIds(store.vault)).toContain(PUBLISHED_LATER);
    expect(told.at(-1)).toContain(PUBLISHED_LATER);
  }, 30_000);
});
