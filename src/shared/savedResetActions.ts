import { z } from "zod";
import type { AccountView } from "./accounts";
import type { ActionLine } from "./actions";
import { englishOf, said } from "./i18n/said";

/**
 * The catalog lines for a Codex account's saved resets (docs/quota.md,
 * "Saved resets" and "Saved resets on their own"): using one now, and the
 * account's switch that lets Infinitary use one on its own. Both are at the
 * own-words tier, since a used reset cannot be given back.
 */
export const savedResetLines = {
  "account-use-saved-resets": {
    area: "intelligence",
    tier: "own-words",
    change: "inf:accounts:use-saved-resets",
    current: "inf:accounts:list",
    value: z.strictObject({
      accountId: z.string().min(1),
      on: z.boolean(),
      deviceId: z.string().min(1).max(64).optional(),
    }),
    line: "Turn a Codex account's Use saved resets on their own on or off by id, only on typed captain words: when work waits on its spent allowance and no account at that level has room, Infinitary may use one of its saved resets without a click; when the account keeps going on credits, credits may serve that work until the reset lands. Turning it on needs Codex signed in to the account; when it is not, the refusal says to turn it on from the account's row in Settings. For an account on a computer that runs work, also pass its deviceId; device-sign-in's state lists its accounts by id.",
    toRequest: (v) =>
      v.deviceId ? [v.accountId, v.on, { deviceId: v.deviceId }] : [v.accountId, v.on],
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({
        id: a.id,
        provider: a.providerId,
        useSavedResets: a.useSavedResets === true,
      })),
    }),
    done: (v) =>
      `${englishOf(said(v.on ? "settingsSubscriptionsMenuUseResets" : "settingsSubscriptionsMenuStopUsingResets"))}: ${v.accountId}`,
  },
  "account-use-reset": {
    area: "intelligence",
    tier: "own-words",
    change: "inf:accounts:use-saved-reset",
    current: "inf:accounts:list",
    value: z.strictObject({
      accountId: z.string().min(1),
      deviceId: z.string().min(1).max(64).optional(),
    }),
    line: "Use one of a Codex account's saved resets by id, only on typed captain words: the Codex CLI on that computer uses the one that expires first, and a reset used cannot be given back. It needs Codex signed in to the account; when it is not, the refusal says to choose Use a saved reset on the account's row in Settings. For an account on a computer that runs work, also pass its deviceId; device-sign-in's state lists its accounts by id.",
    toRequest: (v) => (v.deviceId ? [v.accountId, { deviceId: v.deviceId }] : [v.accountId]),
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({ id: a.id, provider: a.providerId })),
    }),
    done: (v) => `${englishOf(said("cardUseSavedReset"))}: ${v.accountId}`,
  },
} as const satisfies Record<string, ActionLine>;
