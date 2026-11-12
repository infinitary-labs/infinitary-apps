import { describe, expect, it } from "vitest";
import {
  backendForProvider,
  CLAUDE_PROVIDER_ID,
  githubEnterpriseHost,
  isOfferedProvider,
  isPiProvider,
  isRetiredProvider,
  PROVIDER_CATALOG,
  providerServesRole,
  providerSignInNote,
} from "./providers";
import { isSensedProvider, QUOTA_TO_PI_PROVIDER, quotaSnapshotViewSchema } from "./quota";

describe("PROVIDER_CATALOG", () => {
  it("offers the five managed providers, Claude the one outside Pi", () => {
    expect(PROVIDER_CATALOG.map((entry) => entry.id)).toEqual([
      "openai-codex",
      "xai",
      CLAUDE_PROVIDER_ID,
      "kimi-coding",
      "github-copilot",
      "openrouter",
    ]);
    // INF-560: the chip's name is "Kimi Code", after Claude.
    expect(PROVIDER_CATALOG.map((entry) => entry.name)).toEqual([
      "Codex",
      "Grok",
      "Claude",
      "Kimi Code",
      "Copilot",
      "OpenRouter",
    ]);
    expect(PROVIDER_CATALOG.find((entry) => entry.id === "kimi-coding")?.tier).toBe("subscription");
    expect(PROVIDER_CATALOG.find((entry) => entry.id === "openrouter")?.tier).toBe("key");
    // The bare "anthropic" Pi provider is still not offered: a Claude
    // subscription is reachable only through Claude's own client, never
    // through Pi (its OAuth is refused for third-party clients).
    expect(PROVIDER_CATALOG.some((entry) => entry.id === "anthropic")).toBe(false);
    expect(isOfferedProvider("anthropic")).toBe(false);
    expect(isOfferedProvider(CLAUDE_PROVIDER_ID)).toBe(true);
    expect(isOfferedProvider("openai-codex")).toBe(true);
    expect(isOfferedProvider("openrouter")).toBe(true);
  });

  it("serves every subscription through Pi, Claude the sole exception (captain, 2026-09-24)", () => {
    expect(PROVIDER_CATALOG.filter((entry) => entry.backend !== "pi").map((e) => e.id)).toEqual([
      CLAUDE_PROVIDER_ID,
    ]);
    // Cursor left: not offered, and a stored account for it is
    // retired rather than read as a Pi provider. Kimi Code and Copilot came back (INF-560).
    expect(isRetiredProvider("kimi-coding")).toBe(false);
    expect(isPiProvider("kimi-coding")).toBe(true);
    expect(isRetiredProvider("github-copilot")).toBe(false);
    expect(isPiProvider("github-copilot")).toBe(true);
    expect(isOfferedProvider("cursor")).toBe(false);
    expect(isRetiredProvider("cursor")).toBe(true);
    expect(isPiProvider("cursor")).toBe(false);
  });

  it("routes each provider to the backend that can actually reach it", () => {
    expect(backendForProvider("openai-codex")).toBe("pi");
    expect(backendForProvider("openrouter")).toBe("pi");
    expect(backendForProvider(CLAUDE_PROVIDER_ID)).toBe("claude");
    expect(isPiProvider("openai-codex")).toBe(true);
    expect(isPiProvider(CLAUDE_PROVIDER_ID)).toBe(false);
    // An unknown id defaults to Pi but is not offered anywhere.
    expect(backendForProvider("mystery")).toBe("pi");
    expect(isPiProvider("mystery")).toBe(false);
  });

  it("puts no note on a subscription's chip, Copilot's included, the captain's answer (INF-838)", () => {
    expect(isPiProvider("github-copilot")).toBe(true);
    expect(isRetiredProvider("github-copilot")).toBe(false);
    expect(providerSignInNote({ tier: "subscription" })).toBeUndefined();
    // A key carries "API key".
    expect(providerSignInNote({ tier: "key" })).toBe("API key");
  });

  it("reads a typed GitHub Enterprise host as the sign-in uses it, and refuses what is not one (INF-838)", () => {
    expect(githubEnterpriseHost("company.ghe.com")).toBe("company.ghe.com");
    expect(githubEnterpriseHost(" https://github.example.org/login ")).toBe("github.example.org");
    // Blank and github.com itself are github.com, never an Enterprise host.
    expect(githubEnterpriseHost("")).toBeNull();
    expect(githubEnterpriseHost("github.com")).toBeNull();
    // A typo the sign-in library would end the attempt on.
    expect(githubEnterpriseHost("not a host!")).toBeNull();
    expect(githubEnterpriseHost("company")).toBeNull();
  });

  it("lets every offered provider run the Firstmate and crew, Claude included (W1)", () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(providerServesRole(entry.id, "firstmate")).toBe(true);
      expect(providerServesRole(entry.id, "crewmate")).toBe(true);
    }
    expect(providerServesRole(CLAUDE_PROVIDER_ID, "firstmate")).toBe(true);
    // A custom provider from models.json is outside the catalog but rides
    // the base Pi runtime, so it serves both roles; a retired one serves none.
    expect(providerServesRole("fm-mock", "firstmate")).toBe(true);
    expect(providerServesRole("fm-mock", "crewmate")).toBe(true);
    expect(providerServesRole("cursor", "firstmate")).toBe(false);
  });
});

describe("quota mapping", () => {
  it("maps Claude quota to its own provider, never to a Pi one", () => {
    expect(QUOTA_TO_PI_PROVIDER.claude).toBe(CLAUDE_PROVIDER_ID);
    expect(QUOTA_TO_PI_PROVIDER.claude).not.toBe("anthropic");
    expect(QUOTA_TO_PI_PROVIDER.codex).toBe("openai-codex");
    expect(QUOTA_TO_PI_PROVIDER.grok).toBe("xai");
    expect(QUOTA_TO_PI_PROVIDER.cursor).toBeUndefined();
    expect(QUOTA_TO_PI_PROVIDER.copilot).toBe("github-copilot");
    expect(QUOTA_TO_PI_PROVIDER.kimi).toBe("kimi-coding");
  });

  it("marks only sensed providers as having an allowance reader", () => {
    expect(isSensedProvider("openai-codex")).toBe(true);
    expect(isSensedProvider("xai")).toBe(true);
    expect(isSensedProvider(CLAUDE_PROVIDER_ID)).toBe(true);
    expect(isSensedProvider("kimi-coding")).toBe(true);
    expect(isSensedProvider("github-copilot")).toBe(true);
    expect(isSensedProvider("cursor")).toBe(false);
    expect(isSensedProvider("openrouter")).toBe(false);
    expect(isSensedProvider("mystery")).toBe(false);
  });

  it("still parses a persisted Claude quota snapshot without crashing", () => {
    const parsed = quotaSnapshotViewSchema.parse({
      generatedAt: "2026-08-13T20:00:00Z",
      fetchedAt: 1,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          status: "ok",
          stale: false,
          windows: [],
        },
      ],
    });
    expect(parsed.providers[0]?.provider).toBe("claude");
  });
});
