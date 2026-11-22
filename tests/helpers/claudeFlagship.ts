import { Flagship } from "../../src/core/orchestrator/flagship";
import type { ModelRuntime } from "../../src/core/pi/types";
import type { SettingsStore } from "../../src/core/storage/settingsStore";

export const CLAUDE_ACCOUNT = "acct_claude";

export const CLAUDE_SEAT_MODEL = { provider: "anthropic-claude", id: "claude-opus" };

/**
 * The real flagship over a vault holding one Claude login on the machine's
 * default login: the seat binds to it (W1 S12). `refused` stands a refusal
 * on it, so it serves nothing.
 */
export function claudeFlagship(
  options: { refused?: boolean } = {},
): (settings: SettingsStore) => Flagship {
  const account = {
    id: CLAUDE_ACCOUNT,
    providerId: "anthropic-claude",
    label: "Claude",
    enabled: true,
  };
  return (settings) =>
    new Flagship({
      vault: {
        list: (providerId) => (!providerId || providerId === account.providerId ? [account] : []),
        get: (accountId) => (accountId === account.id ? account : undefined),
        connectedSync: () => true,
        servesSync: () => !options.refused,
        withheldReason: () => (options.refused ? "refused" : undefined),
        withheldDetail: () => undefined,
        cutOff: () => (options.refused ? { class: "refused" as const } : undefined),
        tryAgain: () => false,
        runtimeFor: async () => {
          throw new Error("a Claude login has no Pi runtime");
        },
        binding: () => ({ via: "default-login" }),
      },
      settings,
      quota: { latest: () => undefined },
      baseRuntime: {} as ModelRuntime,
    });
}
