import type { AccountView } from "@shared/accounts";
import type { ActionName } from "@shared/actions";
import type { SettingStep } from "./actionTrail";

/**
 * What an account action's trail says: its words'
 * values and, for a setting of the account, what it was and what it is now.
 * A rename and a disconnect are acts on an account; a pause, a preference
 * and Keep going on credits are its settings.
 */
export function accountTrail(
  name: ActionName,
  args: readonly unknown[],
  before: AccountView[],
  after: AccountView[],
): { value: Record<string, unknown>; step?: SettingStep } {
  const account = before.find((a) => a.id === args[0]);
  const target = String(args[0]);
  if (name === "account-prefer") {
    // Which account a provider prefers, by id: the state a run of prefers settles.
    const preferred = (list: AccountView[]) =>
      list.find((a) => a.providerId === args[0] && a.pinned)?.id ?? null;
    return {
      value: { provider: args[0], accountId: after.find((a) => a.id === args[1])?.label ?? null },
      step: { target, from: preferred(before), to: preferred(after) },
    };
  }
  const value = {
    accountId: account?.label ?? args[0],
    label: args[1],
    paused: !args[1],
    on: args[1],
  };
  if (name === "account-pause")
    return { value, step: { target, from: !account?.enabled, to: !args[1] } };
  if (name === "account-keep-going") {
    return {
      value,
      step: { target, from: account?.keepGoingOnCredits === true, to: args[1] === true },
    };
  }
  return { value };
}
