import { describe, expect, it } from "vitest";
import type { AccountBackend } from "./accountBackend";
import { buildProviderViews } from "./providerViews";

/** A backend that answers only what the provider list asks. */
function backend(
  id: AccountBackend["id"],
  authTypes: ("oauth" | "api_key")[],
  unavailable?: { note: string; detail: string },
): AccountBackend {
  return {
    id,
    authTypes: () => authTypes,
    ...(unavailable ? { unavailable: () => unavailable } : {}),
  } as unknown as AccountBackend;
}

describe("buildProviderViews", () => {
  it("lists a backend-served provider with its auth methods and its accounts' state", () => {
    const views = buildProviderViews({
      piProviders: () => [],
      backends: new Map([["claude", backend("claude", ["oauth"])]]),
      accounts: () => [{ providerId: "anthropic-claude", connected: true }],
    });
    expect(views).toEqual([
      {
        id: "anthropic-claude",
        name: "Claude",
        tier: "subscription",
        authTypes: ["oauth"],
        connected: true,
        activeAuthType: "oauth",
        billedPerToken: false,
      },
    ]);
  });

  it("drops a provider whose backend has no way in and nothing to say", () => {
    const views = buildProviderViews({
      piProviders: () => [],
      backends: new Map([["claude", backend("claude", [])]]),
      accounts: () => [],
    });
    expect(views).toEqual([]);
  });

  /**
   * F14: the Claude client is the one the person installed. A Mac without it
   * still lists Claude - disabled, with the words - so the option and what to
   * do about it are visible instead of silently missing.
   */
  it("keeps a provider whose backend says why there is no way in, with no auth method", () => {
    const unavailable = {
      note: "install Claude Code first",
      detail: "Claude Code isn't installed.",
    };
    const views = buildProviderViews({
      piProviders: () => [],
      backends: new Map([["claude", backend("claude", [], unavailable)]]),
      accounts: () => [{ providerId: "anthropic-claude", connected: true }],
    });
    expect(views).toEqual([
      {
        id: "anthropic-claude",
        name: "Claude",
        tier: "subscription",
        authTypes: [],
        unavailable,
        connected: true,
        activeAuthType: "oauth",
        billedPerToken: false,
      },
    ]);
  });

  it("never asks the backend why when there is a way in", () => {
    const views = buildProviderViews({
      piProviders: () => [],
      backends: new Map([
        ["claude", backend("claude", ["oauth"], { note: "never shown", detail: "never shown" })],
      ]),
      accounts: () => [],
    });
    expect(views[0]?.unavailable).toBeUndefined();
  });
});
