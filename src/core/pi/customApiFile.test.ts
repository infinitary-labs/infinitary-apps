import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { readCustomApiFile } from "./customApiFile";

const fixture = readFileSync(join(__dirname, "fixtures", "connectionFile.json"), "utf8");
// The schema Pi publishes for models.json, as installed; its package exports no path to it.
const piSchema = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../../../node_modules/@earendil-works/pi-coding-agent/schemas/models.schema.json",
    ),
    "utf8",
  ),
);
const read = (providers: Record<string, unknown>) =>
  readCustomApiFile(JSON.stringify({ providers }));
const base = { baseUrl: "https://llm-gateway.example.com/v1", api: "openai-completions" };

describe("a connection file in Pi's models.json format", () => {
  it("is a file Pi's own schema accepts", () => {
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(piSchema);
    expect(validate(JSON.parse(fixture)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("reads each provider as a connection, with secret headers left for each computer", () => {
    expect(readCustomApiFile(fixture)).toEqual({
      connections: [
        {
          name: "my-provider",
          warnings: [],
          definition: {
            label: "My provider",
            baseUrl: "https://llm-gateway.example.com/v1",
            protocol: "openai-completions",
            headers: [
              { name: "X-Tenant-Id", secret: false, value: "team-a" },
              { name: "X-Gateway-Token", secret: true },
            ],
            compaction: { keepRecentTokens: 20000, reserveTokens: 16384 },
            models: [
              {
                id: "my-large-model",
                name: "My Large Model",
                context: 200000,
                output: 32000,
                input: ["text", "image"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                cacheRetention: "short",
                statedReasoning: {
                  thinkingLevelMap: {
                    off: null,
                    minimal: null,
                    low: "low",
                    medium: "medium",
                    high: "high",
                    xhigh: "max",
                  },
                },
              },
              {
                id: "my-small-model",
                name: "My Small Model",
                context: 128000,
                output: 16000,
                input: ["text"],
                cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.5 },
                cacheRetention: "none",
              },
            ],
          },
        },
        {
          name: "my-local-server",
          warnings: [],
          definition: {
            label: "my-local-server",
            baseUrl: "http://127.0.0.1:8080/v1",
            protocol: "openai-responses",
            headers: [],
            compaction: { keepRecentTokens: 8000, reserveTokens: 4096 },
            models: [
              {
                id: "local-model",
                name: "Local Model",
                context: 32000,
                output: 8000,
                input: ["text"],
              },
            ],
          },
        },
      ],
    });
  });

  it("reads Pi's comments and trailing commas, and leaves the same marks inside strings alone", () => {
    const reading = readCustomApiFile(`{
      // a gateway this team shares
      "providers": {
        "gateway": {
          "baseUrl": "https://llm-gateway.example.com/v1//team",
          "api": "openai-completions",
          "models": [{ "id": "a,]model", },],
        },
      },
    }`);
    expect(reading.connections[0]?.definition).toMatchObject({
      baseUrl: "https://llm-gateway.example.com/v1//team",
      models: [{ id: "a,]model", context: 0, output: 0 }],
    });
  });

  it("is invalid when it is not JSON or has no providers", () => {
    expect(readCustomApiFile("{ not json")).toEqual({ failure: "invalid", connections: [] });
    expect(readCustomApiFile('{"connections": []}')).toEqual({
      failure: "invalid",
      connections: [],
    });
  });

  it("warns of each key, sign-in, reference and setting it never uses", () => {
    const [connection] = read({
      gateway: {
        ...base,
        apiKey: "$GATEWAY_KEY",
        oauth: "radius",
        authHeader: true,
        modelOverrides: {},
        headers: { "X-From-Env": "$TENANT", "X-From-Command": "!print-tenant", "X-Plain": "a" },
        infinitary: { defaultLevel: "high" },
        models: [
          {
            id: "own-address",
            baseUrl: "https://elsewhere.example.com/v1",
            headers: { "X-Model": "b" },
            samplingParams: { temperature: 0.2 },
            promptCache: { short: 300 },
            cost: { input: 1, tiers: [] },
          },
        ],
      },
    }).connections;
    expect(connection?.warnings).toEqual([
      { kind: "key", key: "apiKey" },
      { kind: "oauth", key: "oauth" },
      { kind: "auth-header", key: "authHeader" },
      { kind: "model-overrides", key: "modelOverrides" },
      { kind: "unused", key: "infinitary.defaultLevel" },
      { kind: "header-reference", key: "X-From-Env" },
      { kind: "header-reference", key: "X-From-Command" },
      { kind: "unused", key: "promptCache", model: "own-address" },
      { kind: "model-address", key: "baseUrl", model: "own-address" },
      { kind: "model-headers", key: "headers", model: "own-address" },
      { kind: "sampling", key: "samplingParams", model: "own-address" },
      { kind: "unused", key: "cost.tiers", model: "own-address" },
    ]);
    // Neither a reference nor its name reaches a request.
    expect(connection?.definition?.headers).toEqual([
      { name: "X-Plain", secret: false, value: "a" },
    ]);
    expect(connection?.definition?.models[0]?.cost).toEqual({ input: 1 });
  });

  it("reads header values as Pi does: a reference anywhere is never sent, and an escaped mark is plain", () => {
    const [connection] = read({
      gateway: {
        ...base,
        headers: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's own reference syntax, as a file holds it
          "X-Bearer": "Bearer ${TENANT_TOKEN}",
          "X-Suffix": "team-$TENANT",
          "X-Price": "$$5 and $!",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's own reference syntax, as a file holds it
          "X-Odd": "${not a name} costs $ 5",
          "X-Gateway-Token": "$GATEWAY_TOKEN",
        },
        infinitary: { secretHeaders: ["X-Gateway-Token"] },
      },
    }).connections;
    expect(connection?.warnings).toEqual([
      { kind: "header-reference", key: "X-Bearer" },
      { kind: "header-reference", key: "X-Suffix" },
    ]);
    expect(connection?.definition?.headers).toEqual([
      { name: "X-Price", secret: false, value: "$5 and !" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's own reference syntax, as a file holds it
      { name: "X-Odd", secret: false, value: "${not a name} costs $ 5" },
      { name: "X-Gateway-Token", secret: true },
    ]);
  });

  it("warns when kept history and the summary's room do not fit a model's window", () => {
    const [connection] = read({
      gateway: {
        ...base,
        infinitary: { compaction: { keepRecentTokens: 20000, reserveTokens: 16384 } },
        models: [
          { id: "fits", contextWindow: 200000, maxTokens: 8000 },
          { id: "small", contextWindow: 32000, maxTokens: 8000 },
        ],
      },
    }).connections;
    expect(connection?.warnings).toEqual([
      { kind: "compaction", key: "compaction", model: "small" },
    ]);
  });

  it("refuses a built-in provider's name, a missing address or protocol, and a malformed entry", () => {
    const reading = read({
      openai: base,
      "no-address": { api: "openai-completions" },
      "no-protocol": { baseUrl: base.baseUrl, api: "google-generative-ai" },
      "no-id": { ...base, models: [{ name: "Unnamed" }] },
      twice: { ...base, models: [{ id: "a" }, { id: "a" }] },
      "bad-limit": { ...base, models: [{ id: "a", contextWindow: -1 }] },
      "long-header": { ...base, headers: { [`X-${"a".repeat(200)}`]: "b" } },
      "long-id": { ...base, models: [{ id: "m".repeat(300) }] },
    });
    expect(reading.connections.map(({ name, refused }) => ({ name, refused }))).toEqual([
      { name: "openai", refused: "built-in" },
      { name: "no-address", refused: "address" },
      { name: "no-protocol", refused: "protocol" },
      { name: "no-id", refused: "invalid" },
      { name: "twice", refused: "invalid" },
      { name: "bad-limit", refused: "invalid" },
      { name: "long-header", refused: "invalid" },
      { name: "long-id", refused: "invalid" },
    ]);
  });
});
