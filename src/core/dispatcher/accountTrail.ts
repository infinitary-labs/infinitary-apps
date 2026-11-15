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
  /**
   * The computer that runs work the account is on, and where its words put
   * it ("on Mac mini"); `before` and `after` are then that computer's own
   * accounts.
   */
  there?: { deviceId: string; where?: string },
): { value: Record<string, unknown>; step?: SettingStep } {
  const account = before.find((a) => a.id === args[0]);
  // A computer's account is named by its key, so its run is never this Mac's.
  const target = there ? `${args[0]}@${there.deviceId}` : String(args[0]);
  const where = there?.where;
  if (name === "account-prefer") {
    // Which account a provider prefers, by id: the state a run of prefers settles.
    const preferred = (list: AccountView[]) =>
      list.find((a) => a.providerId === args[0] && a.pinned)?.id ?? null;
    const label = after.find((a) => a.id === args[1])?.label;
    const preferredLabel = label && where ? `${label} ${where}` : label;
    return {
      value: { provider: args[0], accountId: preferredLabel ?? null },
      step: { target, from: preferred(before), to: preferred(after) },
    };
  }
  const named = account?.label ?? args[0];
  const value = {
    accountId: where ? `${named} ${where}` : named,
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
