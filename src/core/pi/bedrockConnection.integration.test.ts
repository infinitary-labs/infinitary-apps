import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createSecureServer } from "node:http2";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import * as m from "@shared/i18n/messages.generated";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { type AuthPromptView, BEDROCK_PROVIDER_ID, BEDROCK_SIGN_IN } from "@shared/providers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { bedrockEvent } from "../../../tests/helpers/bedrockEventStream";
import { collectorTlsFixture } from "../../../tests/helpers/collectorTlsFixture";
import { customApiCaFixture } from "../../../tests/helpers/customApiCaFixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BedrockClaudeSetup } from "../claude/claudeAccess";
import { appPathsFor } from "../paths";
import { useSystemRootsForTests } from "../trustedRoots";
import { AccountVault } from "./accountVault";
import { BEDROCK_ADDRESS_ENV, BEDROCK_NETWORK_ENV } from "./bedrock";
import { bedrockConnection, bedrockConnectionFailure } from "./bedrockConnection";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";
import { PiAccountBackend } from "./piAccountBackend";
import type { AuthInteractionBridge } from "./piAuth";

/**
 * The approved plan for an Amazon Bedrock account sent through an
 * organization's own address (docs/subscriptions-tab.md, "Amazon Bedrock"):
 * the address and its network kind are approved once and kept, every
 * connection is held to that kind and checks certificates against this
 * computer's trusted list, nothing around the app redirects a request, and
 * an organization address may sign requests itself with no key. The
 * organization's address is a real local HTTPS server on a certificate for
 * `gateway.example.test` whose authority only the stand-in trusted list
 * holds; the name's DNS answers are the case's own.
 */

const HOST = "gateway.example.test";
const KEY = "disposable-bedrock-key";
const PROFILE_KEY_ID = "AKIDBEDROCKADDRESS";
/** The one model the stand-in answers; every other is refused as AWS refuses it. */
const MODEL =
  Object.entries(STARTER_SLOTS[BEDROCK_PROVIDER_ID] ?? {}).find(
    ([id, slots]) => id.startsWith("us.") && slots.includes("medium"),
  )?.[0] ?? "";

let tls: ReturnType<typeof customApiCaFixture>;
let profileDir: string;
beforeAll(() => {
  tls = customApiCaFixture(scratchDir("infinitary-bedrock-address-tls-"));
  profileDir = scratchDir("infinitary-bedrock-address-profile-");
  writeFileSync(
    join(profileDir, "credentials"),
    `[fixture]\naws_access_key_id=${PROFILE_KEY_ID}\naws_secret_access_key=disposable-profile-secret\n`,
    { mode: 0o600 },
  );
  // A profile's own endpoint is somewhere a request must never go.
  writeFileSync(
    join(profileDir, "config"),
    "[profile fixture]\nendpoint_url = https://127.0.0.1:9\n",
    { mode: 0o600 },
  );
});

/** What the case's DNS answers for the organization's name. */
let answers: string[] = [];
const resolve = async (hostname: string) => {
  if (hostname !== HOST) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return answers;
};

const servers: Server[] = [];
beforeEach(() => {
  answers = ["127.0.0.1"];
  useSystemRootsForTests(() => [tls.ca]);
  vi.stubEnv("PI_OFFLINE", "1");
  // Everything around the app that could send or sign a request elsewhere.
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "ALL_PROXY"])
    vi.stubEnv(name, "http://127.0.0.1:9");
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("AWS_ENDPOINT_URL", "https://127.0.0.1:9");
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "https://127.0.0.1:9");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDAMBIENT");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "disposable-ambient-secret");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "disposable-ambient-key");
  vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(profileDir, "credentials"));
  vi.stubEnv("AWS_CONFIG_FILE", join(profileDir, "config"));
});
afterEach(async () => {
  await catalogRefreshesSettled();
  vi.unstubAllEnvs();
  useSystemRootsForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    ),
  );
});

/** A one-word Bedrock answer in AWS's event-stream format. */
const answer = () =>
  Buffer.concat([
    bedrockEvent("messageStart", { role: "assistant" }),
    bedrockEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }),
    bedrockEvent("contentBlockStop", { contentBlockIndex: 0 }),
    bedrockEvent("messageStop", { stopReason: "end_turn" }),
    bedrockEvent("metadata", {
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 1 },
    }),
  ]);

type Seen = { model: string; httpVersion: string; authorization?: string; signed: boolean };

/** The organization's address: answers the one model, refuses the rest. */
async function organization() {
  const seen: Seen[] = [];
  const server = createServer({ cert: tls.leaf, key: tls.leafKey }, async (request, response) => {
    for await (const _ of request);
    const model = decodeURIComponent(request.url?.split("/")[2] ?? "");
    seen.push({
      model,
      httpVersion: request.httpVersion,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      signed: Object.keys(request.headers).some((name) => name.startsWith("x-amz-security")),
    });
    if (model !== MODEL) {
      response.writeHead(403, {
        "content-type": "application/json",
        "x-amzn-errortype": "AccessDeniedException",
      });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    response.end(answer());
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return { address: `https://${HOST}:${port}`, host: `${HOST}:${port}`, seen };
}

type Answer = (prompt: AuthPromptView) => string;

/** The person's side of a sign-in: each prompt they see, answered in turn. */
function person(answer: Answer[]) {
  const prompts: AuthPromptView[] = [];
  const bridge: AuthInteractionBridge = {
    prompt: async (prompt) => {
      prompts.push(prompt);
      const next = answer.shift();
      if (!next) throw new Error(`Unexpected prompt: ${prompt.message}`);
      return next(prompt);
    },
    notify: () => {},
    openExternal: async () => {},
  };
  return { bridge, prompts };
}

const pick =
  (label: string): Answer =>
  (prompt) => {
    const option = prompt.options?.find((candidate) => candidate.label === label);
    if (!option) throw new Error(`No option "${label}" in: ${prompt.message}`);
    return option.id;
  };
const type =
  (words: string): Answer =>
  () =>
    words;
const approve: Answer = pick(m.bedrockSignInSend());

function vaultWith(options: { claudeSetup?: () => Promise<BedrockClaudeSetup | undefined> } = {}) {
  return AccountVault.create(appPathsFor(scratchDir("infinitary-bedrock-address-")), {
    pi: new PiAccountBackend({
      bedrockResolve: resolve,
      ...(options.claudeSetup ? { bedrockClaudeSetup: options.claudeSetup } : {}),
    }),
  });
}

/** One request with the account's saved sign-in, through the account's own runtime. */
async function ask(vault: AccountVault, accountId: string) {
  const runtime = await vault.runtimeFor(accountId);
  const saved = await runtime.getAuth(BEDROCK_PROVIDER_ID);
  const provider = runtime.getProvider(BEDROCK_PROVIDER_ID);
  const model = provider?.getModels().find(({ id }) => id === MODEL);
  if (!saved || !provider || !model) throw new Error("Missing saved Bedrock account");
  return provider
    .streamSimple(
      model,
      normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] }),
      { ...(saved.auth.apiKey ? { apiKey: saved.auth.apiKey } : {}), env: saved.env, maxTokens: 1 },
    )
    .result();
}

const keyAnswers = (address: string): Answer[] => [
  pick(BEDROCK_SIGN_IN.key),
  type("us-west-2"),
  pick(m.bedrockSignInOrganization()),
  type(address),
  approve,
  type(KEY),
];

describe("an Amazon Bedrock account sent through an organization's address", () => {
  it("approves the address and its network once, sends there over HTTP/1.1 and names it on the row", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const { bridge, prompts } = person(keyAnswers(gateway.address));
    const account = await vault.add(BEDROCK_PROVIDER_ID, "api_key", bridge);

    const approval = prompts.find((prompt) => prompt.options?.[0]?.label === m.bedrockSignInSend());
    expect(approval?.message).toBe(m.bedrockSignInApproveLocal({ host: gateway.host }));
    expect(gateway.seen.length).toBeGreaterThan(0);
    expect(gateway.seen.every((request) => request.httpVersion === "1.1")).toBe(true);
    expect(gateway.seen.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(true);
    const view = (await vault.views()).find((row) => row.id === account.id);
    expect(view?.sentThrough).toBe(gateway.host);
    expect((await ask(vault, account.id)).stopReason).not.toBe("error");
  }, 30_000);

  it("signs requests with the account's AWS profile at the organization's address", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const { bridge } = person([
      pick(BEDROCK_SIGN_IN.profile),
      type("us-west-2"),
      pick(m.bedrockSignInOrganization()),
      type(gateway.address),
      approve,
      type("fixture"),
    ]);
    await vault.add(BEDROCK_PROVIDER_ID, "api_key", bridge);
    const credential = gateway.seen[0]?.authorization ?? "";
    expect(credential).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${PROFILE_KEY_ID}/\\d{8}/us-west-2/bedrock/`),
    );
  }, 30_000);

  it("refuses a request once the name answers outside the approved network, before connecting", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const account = await vault.add(
      BEDROCK_PROVIDER_ID,
      "api_key",
      person(keyAnswers(gateway.address)).bridge,
    );
    const before = gateway.seen.length;
    // A documentation address no network routes, so a build that skipped the check reaches nothing.
    answers = ["192.0.2.1"];
    const result = await ask(vault, account.id);
    expect(result.stopReason).toBe("error");
    expect(bedrockConnectionFailure(result)).toBe("destination");
    expect(gateway.seen.length).toBe(before);
  }, 30_000);

  it("says a certificate this computer does not trust apart from an address it cannot reach", async () => {
    const gateway = await organization();
    useSystemRootsForTests(() => []);
    await expect(
      vaultWith().add(BEDROCK_PROVIDER_ID, "api_key", person(keyAnswers(gateway.address)).bridge),
    ).rejects.toThrow(m.bedrockSecureConnectionFailed({ host: gateway.host }));
    expect(gateway.seen).toEqual([]);

    useSystemRootsForTests(() => [tls.ca]);
    const closed = createHttpServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    await expect(
      vaultWith().add(
        BEDROCK_PROVIDER_ID,
        "api_key",
        person(keyAnswers(`https://${HOST}:${port}`)).bridge,
      ),
    ).rejects.toThrow(m.bedrockUnreachable({ host: `${HOST}:${port}` }));
  }, 30_000);

  it("sends no credentials at all with no key, though the computer holds AWS credentials", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const { bridge, prompts } = person([
      pick(m.bedrockSignInNoKey()),
      type("us-west-2"),
      type(gateway.address),
      approve,
    ]);
    const account = await vault.add(BEDROCK_PROVIDER_ID, "api_key", bridge);
    // No key leaves only the organization's address, so where to send is not asked.
    expect(prompts.map((prompt) => prompt.kind)).toEqual(["select", "text", "text", "select"]);
    expect(gateway.seen.length).toBeGreaterThan(0);
    expect(gateway.seen.every((request) => !request.authorization && !request.signed)).toBe(true);
    expect((await ask(vault, account.id)).stopReason).not.toBe("error");
  }, 30_000);

  it("starts from Claude Code's Bedrock settings, says so and still asks for approval", async () => {
    const gateway = await organization();
    const vault = vaultWith({
      claudeSetup: async () => ({
        source: "organization",
        address: gateway.address,
        region: "us-west-2",
        profile: "fixture",
      }),
    });
    const accept: Answer = (prompt) => prompt.value ?? "";
    const { bridge, prompts } = person([
      pick(BEDROCK_SIGN_IN.profile),
      accept,
      pick(m.bedrockSignInOrganization()),
      accept,
      approve,
      accept,
    ]);
    await vault.add(BEDROCK_PROVIDER_ID, "api_key", bridge);
    const texts = prompts.filter((prompt) => prompt.kind === "text");
    expect(texts.map((prompt) => prompt.value)).toEqual(["us-west-2", gateway.address, "fixture"]);
    expect(
      texts.every((prompt) => prompt.message.endsWith(m.bedrockSignInFromOrganization())),
    ).toBe(true);
    expect(prompts.some((prompt) => prompt.options?.[0]?.label === m.bedrockSignInSend())).toBe(
      true,
    );
  }, 30_000);

  it("signs in again to the address it kept, and puts a new network to the person to approve", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const account = await vault.add(
      BEDROCK_PROVIDER_ID,
      "api_key",
      person(keyAnswers(gateway.address)).bridge,
    );
    const again = person([type(KEY)]);
    await vault.signIn(account.id, again.bridge);
    expect(again.prompts.map((prompt) => prompt.kind)).toEqual(["secret"]);
    expect((await vault.views()).find((row) => row.id === account.id)?.sentThrough).toBe(
      gateway.host,
    );

    // The person turns the new network down, so no request is made to it.
    const before = gateway.seen.length;
    answers = ["10.20.30.40"];
    const moved = person([
      () => {
        throw new Error("Not approved");
      },
    ]);
    await expect(vault.signIn(account.id, moved.bridge)).rejects.toThrow("Not approved");
    expect(moved.prompts.map((prompt) => prompt.message)).toEqual([
      m.bedrockSignInApprovePrivate({ host: gateway.host }),
    ]);
    expect(gateway.seen.length).toBe(before);
  }, 30_000);
});

describe("every Amazon Bedrock connection", () => {
  it("trusts this computer's certificate list at AWS's own address too", async () => {
    // AWS's address over HTTP/2, as the stock stream reaches it, here a local
    // stand-in on 127.0.0.1 whose authority only the stand-in trusted list holds.
    const aws = collectorTlsFixture(scratchDir("infinitary-bedrock-aws-tls-"));
    let streams = 0;
    const server = createSecureServer(
      { cert: aws.serverCert, key: aws.serverKey },
      (_, response) => {
        streams += 1;
        response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
        response.end(answer());
      },
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
    const baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runtime = await createModelRuntime({
      authPath: join(scratchDir("infinitary-bedrock-aws-"), "auth.json"),
      modelsPath: join(scratchDir("infinitary-bedrock-aws-models-"), "models.json"),
    });
    const stock = runtime.getProvider(BEDROCK_PROVIDER_ID);
    const model = stock?.getModels().find(({ id }) => id === MODEL);
    if (!stock || !model) throw new Error("Missing Pi's own Bedrock provider");
    const send = () =>
      stock
        .streamSimple(
          { ...model, baseUrl },
          normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] }),
          {
            apiKey: KEY,
            env: { AWS_BEDROCK_SCOPED_AUTH: "1", AWS_REGION: "us-west-2" },
            maxTokens: 1,
            ...bedrockConnection(baseUrl, undefined),
          } as Parameters<typeof stock.streamSimple>[2],
        )
        .result();

    useSystemRootsForTests(() => [aws.ca]);
    const trusted = await send();
    expect(trusted.stopReason).toBe("stop");
    expect(streams).toBe(1);

    useSystemRootsForTests(() => []);
    const refused = await send();
    expect(refused.stopReason).toBe("error");
    expect(bedrockConnectionFailure(refused)).toBe("secure-connection");
    expect(streams).toBe(1);
  }, 30_000);

  it("keeps the address and network it saved beside the region", async () => {
    const gateway = await organization();
    const vault = vaultWith();
    const account = await vault.add(
      BEDROCK_PROVIDER_ID,
      "api_key",
      person(keyAnswers(gateway.address)).bridge,
    );
    const runtime = await vault.runtimeFor(account.id);
    const env = (await runtime.getAuth(BEDROCK_PROVIDER_ID))?.env;
    expect(env?.[BEDROCK_ADDRESS_ENV]).toBe(gateway.address);
    expect(env?.[BEDROCK_NETWORK_ENV]).toBe("local");
  }, 30_000);
});
