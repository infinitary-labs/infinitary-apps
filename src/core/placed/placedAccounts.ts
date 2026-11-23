import { standingCutOff } from "@shared/accounts";
import type { CutOffClass } from "@shared/authFailure";
import { catalogEntry } from "@shared/providers";
import type { ComputerSignIns, signInPlace } from "@shared/signIns";
import type { QuotaCatalogModel } from "../quota/auth";
import {
  actualComputerPool,
  type ComputerPool,
  catalogWhereUnlisted,
  computerPool,
  heldThere,
} from "../routing/computerPool";
import type { ModelSession } from "../session/session";
import type { CrewMachines } from "./crewMachines";
import { PlacedSession } from "./placedSession";

/**
 * What the crew reads of a computer's own sign-ins and accounts (docs/helper.md,
 * "Its own sign-ins"), from what that computer last said of them: the models
 * a task there is routed among, the account a conversation there is bound to,
 * and a cut-off standing on it. Never one of this Mac's own accounts.
 */

export type PlacedAccountsOptions = {
  /**
   * What a computer last said of its own sign-ins (`DeviceSignIns`), asked
   * when it has said nothing yet; absent, it is known to serve nothing.
   */
  signIns?: (deviceId: string) => Promise<ComputerSignIns | null>;
  /**
   * Asks a computer its sign-ins again (`DeviceSignIns.refresh`), so what it
   * says next was written after everything heard from it before: true only
   * when it answered.
   */
  refreshSignIns?: (deviceId: string) => Promise<boolean>;
  /**
   * The same, read now without asking (`DeviceSignIns.lastSaid`): a cut-off
   * it names on the account a task there is bound to holds that task.
   * Absent, nothing there ever holds one.
   */
  saidSignIns?: (deviceId: string) => ComputerSignIns | null;
  /** Every model this Mac's catalog lists, provider-wide, which needs no sign-in here. */
  catalogModels?: () => readonly QuotaCatalogModel[];
  /** How the home's words place a computer (`PlacedSessions.placeOf`). */
  placeOf: (deviceId: string) => ReturnType<typeof signInPlace>;
  now: () => number;
};

export class PlacedAccounts
  implements
    Pick<
      CrewMachines,
      | "signInsOf"
      | "served"
      | "servingAccount"
      | "cutOffOf"
      | "knows"
      | "accountPlace"
      | "signInWait"
    >
{
  constructor(private readonly options: PlacedAccountsOptions) {}

  async signInsOf(machine: string): Promise<ComputerSignIns | null> {
    return (await this.options.signIns?.(machine)) ?? null;
  }

  async served(machine: string, fresh = false): Promise<ComputerPool> {
    // A fresh read is what that computer answers now, never what it said
    // before: one that did not answer confirms nothing.
    if (
      fresh &&
      this.options.refreshSignIns &&
      (await this.options.refreshSignIns(machine).catch(() => false)) !== true
    )
      throw new Error(
        `${this.options.placeOf(machine).who} did not say what it serves now, so nothing opened there is taken yet.`,
      );
    const signIns = (await this.options.signIns?.(machine)) ?? null;
    const who = this.options.placeOf(machine).who;
    const models = this.options.catalogModels?.() ?? [];
    const now = this.options.now();
    // Only the models its sign-ins say they serve, as an Automatic start
    // routes among; an account that lists none, and every account of a
    // computer too old to say, takes this Mac's catalog for its provider.
    const pool =
      actualComputerPool(who, catalogWhereUnlisted(signIns, models), models, now) ??
      computerPool(who, signIns, models, now);
    // A model binds an account whose list names it before one that lists
    // nothing and only stands in with the catalog.
    const actual = actualComputerPool(who, signIns, models, now);
    const listed = actual?.modelAccounts;
    const modelAccounts: ReadonlyMap<string, string> | undefined =
      pool.modelAccounts && listed
        ? new Map([...pool.modelAccounts, ...listed])
        : pool.modelAccounts;
    // An account that lists nothing serves a model only while none lists it.
    const servedBy: ReadonlyMap<string, ReadonlySet<string>> | undefined =
      pool.servedBy && actual ? new Map([...pool.servedBy, ...actual.servedBy]) : pool.servedBy;
    return {
      ...pool,
      ...(modelAccounts ? { modelAccounts } : {}),
      ...(servedBy ? { servedBy } : {}),
      deviceId: machine,
    };
  }

  /**
   * What that computer last said of its sign-ins, and each account's
   * cut-off as it stands now, as one comparable string: a cut-off whose
   * reset passed changes it with no new report.
   */
  servedState(machine: string): string {
    const said = this.options.saidSignIns?.(machine) ?? null;
    const now = this.options.now();
    return JSON.stringify([
      said,
      said?.accounts.map((row) => [row.id, standingCutOff(row, now)?.class ?? null]) ?? null,
    ]);
  }

  servingAccount(session: ModelSession): string | undefined {
    return session instanceof PlacedSession ? session.servingAccount() : undefined;
  }

  cutOffOf(account: string): { class: CutOffClass; since: number; resetsAt?: number } | undefined {
    const row = this.accountRow(account);
    return row ? standingCutOff(row, this.options.now()) : undefined;
  }

  knows(account: string): boolean {
    const key = parseAccountKey(account);
    if (!key || !this.options.saidSignIns) return true;
    return this.options.saidSignIns(key.deviceId) !== null;
  }

  accountPlace(account: string): { provider: string; where: string } | undefined {
    const key = parseAccountKey(account);
    if (!key) return undefined;
    const providerId = this.accountRow(account)?.providerId;
    return {
      provider: providerWord(providerId),
      where: this.options.placeOf(key.deviceId).where,
    };
  }

  signInWait(
    machine: string,
  ): { account: string; provider: string; class: CutOffClass; resetsAt?: number } | undefined {
    const now = this.options.now();
    const held = heldThere(this.options.saidSignIns?.(machine), now);
    const cutOff = held ? standingCutOff(held, now) : undefined;
    return held && cutOff
      ? {
          account: accountKey(machine, held.id),
          provider: providerWord(held.providerId),
          class: cutOff.class,
          ...(cutOff.resetsAt !== undefined ? { resetsAt: cutOff.resetsAt } : {}),
        }
      : undefined;
  }

  private accountRow(account: string) {
    const key = parseAccountKey(account);
    if (!key) return undefined;
    return this.options
      .saidSignIns?.(key.deviceId)
      ?.accounts.find((row) => row.id === key.accountId);
  }
}

/**
 * A computer's own account, keyed apart from this Mac's own account ids (a
 * device id is a UUID and an account id holds no `@`), so the cut-off
 * contract's wakes and once-names can name it beside them.
 */
export function accountKey(deviceId: string, accountId: string): string {
  return `${accountId}@${deviceId}`;
}

export function parseAccountKey(
  account: string,
): { deviceId: string; accountId: string } | undefined {
  const at = account.lastIndexOf("@");
  if (at <= 0 || at === account.length - 1) return undefined;
  return { accountId: account.slice(0, at), deviceId: account.slice(at + 1) };
}

function providerWord(providerId: string | undefined): string {
  return (providerId && catalogEntry(providerId)?.name) || providerId || "its subscription";
}
