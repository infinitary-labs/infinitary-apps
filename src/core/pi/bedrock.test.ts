import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bedrockCode, bedrockModelInRegion } from "./bedrock";
import {
  awsLoginUrl,
  bedrockProfileFailure,
  bedrockProfileIdentity,
  bedrockSignInEnv,
  bedrockSourceProfile,
} from "./bedrockProfile";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";
import { fmEventsFromPiEvent, usageFromMessage } from "./piEvents";

afterEach(async () => {
  await catalogRefreshesSettled();
  vi.unstubAllEnvs();
});

it("does not give the base runtime Bedrock models or auth from the environment (INF-3451)", async () => {
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "disposable");
  vi.stubEnv("PI_OFFLINE", "1");
  const dir = scratchDir("bedrock-isolation-");
  const runtime = await createModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath: join(dir, "models.json"),
  });
  const stock = runtime.getModels("amazon-bedrock");
  expect(stock.length).toBeGreaterThan(0);
  expect(runtime.getAvailableSnapshot().some((model) => model.provider === "amazon-bedrock")).toBe(
    false,
  );
  expect(runtime.getModel("amazon-bedrock", stock[0]?.id ?? "")).toBeUndefined();
  expect(await runtime.getAuth("amazon-bedrock")).toBeUndefined();
});

it.each(["streamSimple", "stream"] as const)(
  "uses only the connected profile or API key in Bedrock %s (INF-3451)",
  async (stream) => {
    const dir = scratchDir("bedrock-auth-scheme-");
    const credentials = join(dir, "credentials");
    const accessKeyId = "AKIDBEDROCKFIXTURE";
    writeFileSync(
      credentials,
      `[fixture]\naws_access_key_id=${accessKeyId}\naws_secret_access_key=disposable-profile-secret\n`,
      { mode: 0o600 },
    );
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentials);
    vi.stubEnv("AWS_CONFIG_FILE", join(dir, "missing-config"));
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "disposable-ambient-key");
    vi.stubEnv("AWS_AUTH_SCHEME_PREFERENCE", "httpBearerAuth");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    const apiKey = "disposable-connected-key";
    const seen: string[] = [];
    const server = createServer((request, response) => {
      const auth = request.headers.authorization ?? "";
      const profile = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/\d{8}\/us-west-2\/bedrock\//.exec(
        auth,
      );
      seen.push(
        profile?.[1] === accessKeyId ? "profile" : auth === `Bearer ${apiKey}` ? "key" : "other",
      );
      response.writeHead(403, {
        "content-type": "application/json",
        "x-amzn-errortype": "AccessDeniedException",
      });
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const runtime = await createModelRuntime({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
        bedrockAccount: true,
        bedrockUrl: `http://127.0.0.1:${address.port}`,
      });
      const provider = runtime.getProvider("amazon-bedrock");
      const model = provider?.getModels().find(({ id }) => bedrockModelInRegion(id, "us-west-2"));
      if (!provider || !model) throw new Error("Missing Bedrock fixture model");
      const context = normalizeContext({
        messages: [{ role: "user", content: "Hi", timestamp: 0 }],
      });
      const env = { AWS_REGION: "us-west-2" };
      const ask = async (options: { env: Record<string, string>; apiKey?: string }) =>
        bedrockCode(await provider[stream](model, context, { ...options, maxTokens: 1 }).result());
      expect(await ask({ env: { ...env, AWS_PROFILE: "fixture" } })).toBe("AccessDeniedException");
      expect(await ask({ env: { ...env, AWS_PROFILE: "missing" } })).toBe(
        "BedrockProfileUnavailableException",
      );
      expect(await ask({ env, apiKey })).toBe("AccessDeniedException");
      expect(seen).toEqual(["profile", "key"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("checks only Claude models and matching cross-region offerings (INF-3451)", () => {
  expect(bedrockModelInRegion("us.anthropic.claude-sonnet-5-5", "us-west-2")).toBe(true);
  expect(bedrockModelInRegion("eu.anthropic.claude-sonnet-5-5", "us-west-2")).toBe(false);
  expect(bedrockModelInRegion("us.amazon.nova-pro-v1:0", "us-west-2")).toBe(false);
});

it.each([
  ["ExpiredTokenException", "signed_out"],
  ["UnrecognizedClientException", "signed_out"],
  ["ThrottlingException", "no_headroom"],
  ["AccessDeniedException", undefined],
  [undefined, undefined],
])(
  "uses the typed AWS refusal %s, never a bare 403 or its prose (INF-3451)",
  (errorCode, expected) => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "403 Forbidden",
      diagnostics: [{ type: "bedrock_response_failure", details: { errorCode, status: 403 } }],
    };
    const failed = fmEventsFromPiEvent(
      { type: "turn_end", message },
      "bedrock-test",
      "amazon-bedrock",
    )[0];
    expect(failed?.type).toBe("turn_failed");
    expect(failed?.type === "turn_failed" && failed.cutOff?.class).toBe(expected);
  },
);

it("recovers from profile resolution errors without mistaking a failed refresh for expiry (INF-3451)", () => {
  const wrapped = (name: string, message: string, status?: number) =>
    new Error("Could not resolve profile", {
      cause: Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } }),
    });
  for (const error of [
    wrapped("CredentialsProviderError", "Token is expired. Run aws sso login."),
    wrapped("ExpiredTokenException", "not a service response"),
    wrapped("ExpiredToken", "non-renewal service response", 403),
    wrapped("InvalidGrantException", "another operation", 400),
    new Error("network unavailable"),
  ]) {
    const failure = bedrockProfileFailure(error);
    expect(failure.name).toBe("BedrockProfileUnavailableException");
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: error.message,
      diagnostics: [{ type: "bedrock_response_failure", details: { errorCode: failure.name } }],
    };
    expect(
      fmEventsFromPiEvent({ type: "turn_end", message }, "bedrock-test", "amazon-bedrock")[0],
    ).toEqual({
      type: "turn_failed",
      taskId: "bedrock-test",
      error: "Could not use your AWS sign-in.",
    });
  }
});

it("preserves named profile permission and throttling failures without offering sign-in (INF-3451)", () => {
  for (const name of ["AccessDeniedException", "ThrottlingException"]) {
    const error = Object.assign(new Error("AWS refusal"), {
      name,
      $metadata: { httpStatusCode: name === "ThrottlingException" ? 429 : 403 },
    });
    expect(bedrockProfileFailure(new Error("Wrapped", { cause: error })).name).toBe(name);
  }
});

it("waits for the remainder of a split AWS sign-in URL (INF-4973)", () => {
  const prefix = "Open https://signin.aws.amazon.com/authorize?state=par";
  expect(awsLoginUrl(prefix)).toBeUndefined();
  expect(awsLoginUrl(`${prefix}t2\n`)).toBe("https://signin.aws.amazon.com/authorize?state=part2");
});

it.each([
  ["CreateOAuth2Token", "AccessDeniedException", "USER_CREDENTIALS_CHANGED", 403],
  ["CreateOAuth2Token", "AccessDeniedException", "TOKEN_EXPIRED", 403],
  ["CreateToken", "InvalidGrantException", undefined, 400],
])(
  "only recognizes terminal renewal from %s and its typed AWS response (INF-4973)",
  (awsRenewalOperation, name, error, httpStatusCode) => {
    const sdk = Object.assign(new Error("AWS response"), {
      name,
      error,
      awsRenewalOperation,
      $metadata: { httpStatusCode },
    });
    const failure = bedrockProfileFailure(new Error("SDK wrapper", { cause: sdk }));
    expect(failure.name).toBe("BedrockProfileRenewalRejectedException");
  },
);

it("does not write zero-initialized Bedrock refusals as unpriced inference (INF-3451)", () => {
  const message = {
    provider: "amazon-bedrock",
    stopReason: "error",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    diagnostics: [{ type: "bedrock_response_failure", details: { status: 403 } }],
  };
  expect(usageFromMessage(message)).toBeUndefined();
  for (const errorCode of ["AccessDeniedException", "ThrottlingException"]) {
    expect(
      usageFromMessage({
        ...message,
        diagnostics: [
          {
            type: "bedrock_response_failure",
            details: { errorCode, stage: "credential_resolution" },
          },
        ],
      }),
    ).toBeUndefined();
  }

  expect(usageFromMessage({ ...message, diagnostics: [] })).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(usageFromMessage({ ...message, usage: { ...message.usage, input: 25 } })?.input).toBe(25);
});

it("gates old checked models until the recovered account is checked again (INF-4973)", async () => {
  const dir = scratchDir("bedrock-recheck-");
  const authPath = join(dir, "auth.json");
  const id = "us.anthropic.claude-sonnet-5-5";
  writeFileSync(
    authPath,
    JSON.stringify({
      "amazon-bedrock": {
        type: "api_key",
        env: { AWS_PROFILE: "fixture", AWS_REGION: "us-west-2", INFINITARY_BEDROCK_MODELS: id },
      },
    }),
    { mode: 0o600 },
  );
  let pending = false;
  const runtime = await createModelRuntime({
    authPath,
    modelsPath: join(dir, "models.json"),
    bedrockAccount: true,
    bedrockRecheckPending: () => pending,
  });
  const admitted = runtime.getModel("amazon-bedrock", id);
  expect(admitted?.id).toBe(id);
  pending = true;
  expect(runtime.getAvailableSnapshot()).toEqual([]);
  expect(runtime.getModel("amazon-bedrock", id)).toBeUndefined();
  if (!admitted) throw new Error("Fixture model was not admitted");
  expect(await runtime.getAuth(admitted)).toBeUndefined();
  expect((await runtime.getAuth("amazon-bedrock"))?.env?.AWS_PROFILE).toBe("fixture");
});

it("groups Bedrock regions by the actual AWS sign-in cache, not the profile name (INF-4973)", () => {
  const profiles = {
    workUs: { sso_session: "team", region: "us-west-2" },
    workEu: { sso_session: "team", region: "eu-west-1" },
    other: { sso_session: "other" },
    role: { role_arn: "arn:aws:iam::111111111111:role/work", source_profile: "workUs" },
    oldUs: { sso_start_url: "https://example.awsapps.com/start" },
    oldEu: { sso_start_url: "https://example.awsapps.com/start" },
    keyOnly: { aws_access_key_id: "disposable", sso_session: "team" },
  };
  const identity = (profile: string) => bedrockProfileIdentity(profiles, profile);
  expect(identity("workUs")).toBe(identity("workEu"));
  expect(identity("role")).toBe(identity("workUs"));
  expect(bedrockSourceProfile(profiles, "role")).toBe("workUs");
  expect(identity("oldUs")).toBe(identity("oldEu"));
  expect(identity("other")).not.toBe(identity("workUs"));
  expect(identity("keyOnly")).not.toBe(identity("workUs"));
});

it("preserves only the AWS profile and console cache selectors for re-sign-in (INF-4973)", () => {
  expect(
    bedrockSignInEnv({
      AWS_CONFIG_FILE: "/fixture/config",
      AWS_SHARED_CREDENTIALS_FILE: "/fixture/credentials",
      AWS_LOGIN_CACHE_DIRECTORY: "/fixture/console-cache",
      AWS_PROFILE: "ambient",
      AWS_ACCESS_KEY_ID: "ambient",
      AWS_SECRET_ACCESS_KEY: "ambient",
      AWS_BEARER_TOKEN_BEDROCK: "ambient",
      AWS_SESSION_TOKEN: "ambient",
      PATH: "/fixture/bin",
    }),
  ).toEqual({
    AWS_CONFIG_FILE: "/fixture/config",
    AWS_SHARED_CREDENTIALS_FILE: "/fixture/credentials",
    AWS_LOGIN_CACHE_DIRECTORY: "/fixture/console-cache",
    PATH: "/fixture/bin",
  });
});
