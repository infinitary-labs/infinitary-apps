import * as m from "@shared/i18n/messages.generated";
import type { Said } from "@shared/i18n/said";
import { said } from "@shared/i18n/said";
import { catalogEntry } from "@shared/providers";
import { allowanceProviderOf } from "@shared/quota";
import type { SavedResetResult } from "@shared/savedResets";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { chatgptAccountId } from "../quota/providers/codex";
import { CodexAppServer, type StartCodexProcess } from "./appServer";
import { type CodexCliCheck, checkCodexCli } from "./codexCli";
import { redeemSavedReset, type SavedResetReach, signInForSavedResets } from "./savedReset";

/**
 * Where a computer's own accounts reach the saved-reset use
 * (docs/codex-client.md): the home's window and cards, the first mate, and
 * a computer that runs work for its own accounts. Each computer's account
 * store keeps the Codex home and the kept attempt; only the home says the
 * outcome in the feed and reads the allowance again.
 */

/** What of an account store a use needs: `AccountVault`'s own methods. */
export type SavedResetVault = {
  get: (accountId: string) => { providerId: string; label: string } | undefined;
  setUseSavedResets: (accountId: string, on: boolean) => void;
  codexHome: (accountId: string) => string;
  codexSignedIn: (accountId: string) => boolean;
  savedResetAttempt: (accountId: string) => { key: string; creditId?: string } | undefined;
  setSavedResetAttempt: (
    accountId: string,
    attempt: { key: string; creditId?: string } | undefined,
  ) => void;
  resolveForQuota: (accountId: string) => Promise<{ apiKey?: string } | undefined>;
};

/** The account as the feed and refusals name it: "Codex · Work". */
export function accountWords(account: { providerId: string; label: string }): string {
  const provider = catalogEntry(account.providerId)?.name ?? account.providerId;
  return account.label && account.label !== provider ? `${provider} · ${account.label}` : provider;
}

/** Whether an account's provider has saved resets Codex can use: ChatGPT's Codex. */
export function takesSavedReset(providerId: string): boolean {
  return allowanceProviderOf(providerId) === "codex";
}

/** A computer's reach for one use, over its own account store. */
export function savedResetReach(
  vault: SavedResetVault,
  version: string,
  stand?: { check?: () => Promise<CodexCliCheck>; start?: StartCodexProcess },
): SavedResetReach {
  return {
    check: stand?.check ?? (() => checkCodexCli()),
    home: (accountId) => vault.codexHome(accountId),
    ownAccountId: async (accountId) => {
      const auth = await vault.resolveForQuota(accountId).catch(() => undefined);
      return auth?.apiKey ? chatgptAccountId(auth.apiKey) : undefined;
    },
    attempt: {
      read: (accountId) => vault.savedResetAttempt(accountId),
      save: (accountId, attempt) => vault.setSavedResetAttempt(accountId, attempt),
      clear: (accountId) => vault.setSavedResetAttempt(accountId, undefined),
    },
    version,
    ...(stand?.start ? { start: stand.start } : {}),
  };
}

/** Uses one of this computer's own account's saved resets. */
export async function redeemOwnSavedReset(
  vault: SavedResetVault,
  reach: SavedResetReach,
  accountId: string,
  bridge?: AuthInteractionBridge,
): Promise<SavedResetResult> {
  const account = vault.get(accountId);
  if (!account) throw new Error("The account is no longer registered.");
  if (!takesSavedReset(account.providerId))
    throw new Error("This account has no saved resets Codex can use.");
  return redeemSavedReset(reach, {
    accountId,
    providerId: account.providerId,
    account: accountWords(account),
    ...(bridge ? { bridge } : {}),
  });
}

/**
 * Turns this computer's own account's Use saved resets on their own on or
 * off (docs/quota.md, "Saved resets on their own"). Turning it on signs
 * Codex in first when it keeps no sign-in for the account, through the
 * bridge, and checks it is the same ChatGPT account; nothing is used.
 */
export async function setOwnUseSavedResets(
  vault: SavedResetVault,
  reach: SavedResetReach,
  accountId: string,
  on: boolean,
  bridge?: AuthInteractionBridge,
): Promise<void> {
  const account = vault.get(accountId);
  if (!account) throw new Error("The account is no longer registered.");
  if (on) {
    if (!takesSavedReset(account.providerId))
      throw new Error("This account has no saved resets Codex can use.");
    const signedIn = vault.codexSignedIn(accountId);
    if (!signedIn && !bridge)
      throw new Error(m.accountsUseSavedResetsSignInFirst({ account: accountWords(account) }));
    // From Settings, Codex's sign-in is checked even when one is kept.
    if (!signedIn || bridge)
      await signInForSavedResets(reach, {
        accountId,
        providerId: account.providerId,
        account: accountWords(account),
        ...(bridge ? { bridge } : {}),
      });
  }
  vault.setUseSavedResets(accountId, on);
}

/**
 * Signs the Codex CLI out of a Codex home, before the account it belongs to
 * is removed. Best effort: a missing or old Codex leaves the folder to the
 * removal.
 */
export async function signOutCodexHome(
  home: string,
  version: string,
  stand?: { check?: () => Promise<CodexCliCheck>; start?: StartCodexProcess },
): Promise<void> {
  const cli = await (stand?.check ?? (() => checkCodexCli()))();
  if (cli.state !== "ready") return;
  const server = await CodexAppServer.start({
    executable: cli.executable,
    home,
    version,
    answerWithinMs: 15_000,
    ...(stand?.start ? { start: stand.start } : {}),
  });
  try {
    await server.request("account/logout", undefined, 15_000);
  } finally {
    server.close();
  }
}

/**
 * The feed line a clear outcome says, naming the account; `auto` says
 * Infinitary used it on its own so waiting work could continue.
 */
export function savedResetLine(account: string, result: SavedResetResult, auto?: boolean): Said {
  if (auto && result.outcome === "used")
    return result.left !== undefined
      ? said("accountsSavedResetUsedAuto", { account, count: result.left })
      : said("accountsSavedResetUsedAutoChecking", { account });
  if (result.outcome === "nothing-to-reset") return said("accountsSavedResetNothing", { account });
  if (result.outcome === "none-left") return said("accountsSavedResetNoneLeft", { account });
  return result.left !== undefined
    ? said("accountsSavedResetUsed", { account, count: result.left })
    : said("accountsSavedResetUsedChecking", { account });
}

export type SavedResetsOptions = {
  vault: SavedResetVault;
  reach: SavedResetReach;
  /** Each computer that runs work's own accounts, used there (`DeviceSignIns`). */
  computers: {
    redeemSavedReset: (
      deviceId: string,
      accountId: string,
      signIn: boolean,
    ) => Promise<SavedResetResult>;
    accountOf: (
      deviceId: string,
      accountId: string,
    ) => { providerId: string; label: string } | undefined;
    /** That computer's own account's Use saved resets on their own, saved there. */
    setUseSavedResets: (
      deviceId: string,
      accountId: string,
      on: boolean,
      signIn: boolean,
    ) => Promise<unknown>;
  };
  /** One feed line. */
  note: (fact: Said) => void;
  /** Reads the allowance again now, as Recheck allowance does. */
  recheck: () => void;
  /** A reset was used: the account's run-out card has nothing left to offer. */
  used?: (accountId: string, deviceId?: string) => void;
};

/** The home's saved-reset use, for its own accounts and each computer's. */
export class SavedResets {
  constructor(private readonly options: SavedResetsOptions) {}

  /**
   * Uses one saved reset of the account, here or with `deviceId` on that
   * computer, and says the outcome in the feed. With a bridge, Codex may
   * sign in through it; without one an account Codex is not signed in to is
   * refused with words saying where to sign in.
   */
  async use(
    accountId: string,
    options: { deviceId?: string; bridge?: AuthInteractionBridge; auto?: boolean },
  ): Promise<SavedResetResult> {
    const { deviceId, bridge, auto } = options;
    const account = deviceId
      ? this.options.computers.accountOf(deviceId, accountId)
      : this.options.vault.get(accountId);
    const result = deviceId
      ? await this.options.computers.redeemSavedReset(deviceId, accountId, bridge !== undefined)
      : await redeemOwnSavedReset(this.options.vault, this.options.reach, accountId, bridge);
    this.options.note(savedResetLine(account ? accountWords(account) : accountId, result, auto));
    if (result.outcome !== "nothing-to-reset") this.options.recheck();
    if (result.outcome === "used") this.options.used?.(accountId, deviceId);
    return result;
  }

  /**
   * Turns the account's Use saved resets on their own on or off, here or
   * with `deviceId` on that computer, saved where the account is. Turning
   * it on signs Codex in first when it must; without a bridge an account
   * Codex is not signed in to is refused with words saying where.
   */
  async setUseSavedResets(
    accountId: string,
    on: boolean,
    options: { deviceId?: string; bridge?: AuthInteractionBridge },
  ): Promise<void> {
    const { deviceId, bridge } = options;
    if (deviceId)
      await this.options.computers.setUseSavedResets(deviceId, accountId, on, bridge !== undefined);
    else await setOwnUseSavedResets(this.options.vault, this.options.reach, accountId, on, bridge);
  }

  /** Whether Codex keeps a sign-in for this computer's own account, so a use needs no browser. */
  signedInHere(accountId: string): boolean {
    return this.options.vault.codexSignedIn(accountId);
  }
}
