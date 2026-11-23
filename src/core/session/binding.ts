import { isCustomApiProvider } from "@shared/customApi";
import { backendForProvider } from "@shared/providers";
import type { ModelRuntime } from "../pi/types";
import type { SessionBinding } from "./session";

export type SessionBinderOptions = {
  /** Builds a Pi account's own runtime (the vault's `runtimeFor`); throws when its store is dead. */
  runtimeFor(accountId: string): Promise<ModelRuntime>;
  /** The base runtime for Pi; absent on a Claude-only caller. */
  baseRuntime?: ModelRuntime;
};

/**
 * Account to backend to binding, in one place. Each caller keeps its own
 * selection - which account, for which provider - and hands the binder the
 * result; the binder only knows how an account becomes a binding. The
 * account's backend is its provider's: a Claude account binds to the
 * machine's own login, which the app never builds a runtime for, and a Pi
 * account to its own runtime.
 */
export class SessionBinder {
  constructor(private readonly options: SessionBinderOptions) {}

  base(): SessionBinding {
    if (!this.options.baseRuntime) throw new Error("No Pi base runtime is configured.");
    return { backend: "pi", runtime: this.options.baseRuntime };
  }

  /**
   * One account's binding, with no fallback: a Pi account whose store cannot
   * build a runtime throws, so a caller walking candidates moves on.
   */
  async bindAccount(accountId: string, providerId: string | undefined): Promise<SessionBinding> {
    if (providerId && backendForProvider(providerId) === "claude") {
      return { backend: "claude", accountId };
    }
    return { backend: "pi", accountId, runtime: await this.options.runtimeFor(accountId) };
  }

  /**
   * An account's binding, or the base runtime when there is no account or
   * its store cannot build a runtime.
   */
  async bind(accountId?: string, providerId?: string): Promise<SessionBinding> {
    if (!accountId) {
      if (providerId && isCustomApiProvider(providerId))
        throw new Error("This custom connection needs its checked account.");
      return this.base();
    }
    try {
      return await this.bindAccount(accountId, providerId);
    } catch (error) {
      if (providerId && isCustomApiProvider(providerId)) throw error;
      return this.base();
    }
  }
}
