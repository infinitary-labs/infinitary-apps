import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
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
 */

const CATALOG = readFileSync(join(__dirname, "fixtures", "pidevOpenAiCodexCatalog.json"), "utf8");
/** The Last-Modified pi.dev sent with that catalog. */
const CATALOG_LAST_MODIFIED = "Fri, 27 Nov 2026 13:22:59 GMT";

function standInToken(): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  return [
    part({ alg: "none" }),
    part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-stand-in" } }),
    "sig",
  ].join(".");
}

const standInNetwork = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const json = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  if (url.host === "pi.dev")
    return url.pathname === "/api/models/providers/openai-codex"
      ? // Pi takes the overlay only when it is newer than its bundled catalog.
        json(CATALOG, { "last-modified": CATALOG_LAST_MODIFIED })
      : new Response("not found", { status: 404 });
  if (url.host === "auth.openai.com") {
    if (url.pathname === "/api/accounts/deviceauth/usercode")
      return json(JSON.stringify({ device_auth_id: "dev-1", user_code: "ABCD-EFGH", interval: 1 }));
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lists GPT-6.2 Sol and Astra once the sign-in lands, and tells the home", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    vi.stubGlobal("fetch", standInNetwork);
    const paths = appPathsFor(scratchDir("infinitary-codex-connect-"));
    const told: string[][] = [];
    const vault = AccountVault.create(paths, {
      pi: appPiAccountBackend(paths.modelsPath, {}, () => told.push(codexIds(vault))),
    });
    await vault.warm();

    await vault.add("openai-codex", "oauth", deviceCodeSignIn);
    await catalogRefreshesSettled();

    expect(codexIds(vault)).toEqual(expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra"]));
    expect(told.at(-1)).toEqual(expect.arrayContaining(["gpt-6.2-sol", "gpt-6.2-astra"]));
  }, 30_000);
});
