import type { AuthPromptView } from "@shared/providers";
import {
  ACCOUNT_LIST_ID_MAX,
  type ComputerSignIns,
  isSignInOrderChannel,
  SERVED_MODELS_MAX,
  type SignInOrderChannel,
  type SignInOrderRequest,
  type SignInStep,
  servedForHome,
  signInOrders,
} from "@shared/signIns";
import { claudeReasoningCapabilities } from "../claude/reasoning";
import type { HostKeychain } from "../host";
import { customCapabilityProfiles } from "../pi/customApiModels";
import type { AuthInteractionBridge } from "../pi/piAuth";
import {
  type ComputerAccounts,
  type ComputerAccountsOptions,
  startComputerAccounts,
} from "./accounts";
import { type ComputerForgesOptions, type HeldForges, startComputerForges } from "./forges";

/**
 * A computer that runs work signing in to its own subscriptions for its
 * home (docs/helper.md, "Its own sign-ins"): it answers the home's sign-in
 * orders (src/shared/signIns.ts) and runs each sign-in here, into its own
 * store. Each step goes to the home once while it is in reach, and the
 * captain's answer comes back once inside an order: this computer keeps it
 * only as long as the provider's own flow holds it.
 *
 * Nothing opens a browser here: a link the flow names is the home's to open,
 * on the captain's screen. A sign-in whose home goes out of reach stops,
 * since nobody could answer it.
 *
 * Its sign-in where projects live (`./forges.ts`) answers the same way: the
 * host's code to read goes to the home as a step, and this computer finishes
 * the sign-in itself.
 */

type Tell = (channel: "inf:work:sign-in" | "inf:work:sign-ins", args: unknown) => Promise<unknown>;

type Running = {
  readonly abort: AbortController;
  /** Prompts waiting for the captain, by prompt id. */
  readonly prompts: Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >;
};

export type SignInHostOptions = {
  accounts: ComputerAccounts;
  forges: HeldForges;
  /** Asks the home once, while it is in reach (`HomeLink.invoke`). */
  tell: Tell;
  log: (line: string) => void;
};

export class SignInHost {
  private readonly running = new Map<string, Running>();
  /** The one sign-in where projects live running here, by the home's id for it. */
  private forging: string | undefined;
  /** Each running sign-in's whole run, its store's cleanup included. */
  private readonly ending = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: SignInHostOptions) {}

  /** Answers one sign-in order the home asked, or throws why not. */
  async answer(channel: string, args: unknown): Promise<unknown> {
    if (this.stopped) throw new Error("This computer is stopping.");
    if (!isSignInOrderChannel(channel))
      throw new Error(`${channel} is not a request this computer answers.`);
    const parsed = signInOrders[channel].request.safeParse(args);
    if (!parsed.success) throw new Error(`Rejected ${channel}: malformed request`);
    return this.order(channel, parsed.data);
  }

  /** What this computer can sign in to and is signed in to, with its allowance. */
  async list(): Promise<ComputerSignIns> {
    const { accounts, forges } = this.options;
    return {
      providers: accounts.providers(),
      accounts: await accounts.vault.views(),
      quota: accounts.allowance(),
      forges: forges.view(),
      // Always present, so a home can tell this computer from one too old to say.
      custom: accounts.vault.customViews(),
      served: accounts.vault.availableModelsByAccount().map((row) => ({
        accountId: row.accountId,
        ...accountListOf(accounts, row.accountId),
        models: servedForHome(
          row.providerId,
          row.models.map((model) => {
            if (model.provider === "anthropic-claude")
              return { ...model, reasoningCapabilities: claudeReasoningCapabilities(model.id) };
            const speeds =
              model.provider === "openai-codex"
                ? accounts.speedCapabilities?.(row.accountId, model.id)
                : undefined;
            const speedsUntil = speeds
              ? accounts.speedExpiresAt?.(row.accountId, model.id)
              : undefined;
            return {
              ...model,
              ...(speeds && speedsUntil ? { speeds: [...speeds], speedsUntil } : {}),
            };
          }),
        ),
      })),
    };
  }

  /** A welcome can follow a quick redial without dropped ever running. */
  reached(): void {
    this.dropped();
    void this.report();
  }

  /** The home went out of reach: nobody can answer a sign-in running here, so each stops. */
  dropped(): void {
    for (const running of this.running.values()) running.abort.abort();
    if (this.forging) this.options.forges.cancel();
  }

  /** Tells the home this computer's sign-ins whole, once, when it is in reach. */
  async report(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.options.tell("inf:work:sign-ins", [await this.list()]);
    } catch (error) {
      this.options.log(`the home did not hear this computer's sign-ins: ${messageOf(error)}`);
    }
  }

  /** Stops every sign-in running here and resolves once each has let go of its store. */
  async close(): Promise<void> {
    this.stopped = true;
    const ending = [...this.ending];
    this.dropped();
    await Promise.all(ending);
    await this.options.accounts.vault.swept();
  }

  private async order<C extends SignInOrderChannel>(
    channel: C,
    request: SignInOrderRequest<C>,
  ): Promise<unknown> {
    switch (channel) {
      case "inf:sign-ins:list":
        return this.list();
      case "inf:sign-ins:start": {
        const [start] = request as SignInOrderRequest<"inf:sign-ins:start">;
        // Asked again: it is already running.
        if (!this.running.has(start.signInId)) this.start(start);
        return { ok: true };
      }
      case "inf:sign-ins:answer": {
        const [answer] = request as SignInOrderRequest<"inf:sign-ins:answer">;
        const waiting = this.running.get(answer.signInId)?.prompts.get(answer.promptId);
        if (!waiting) throw new Error("That sign-in is no longer waiting for an answer.");
        this.running.get(answer.signInId)?.prompts.delete(answer.promptId);
        if (answer.value === null) waiting.reject(new Error("Sign in cancelled"));
        else waiting.resolve(answer.value);
        return { ok: true };
      }
      case "inf:sign-ins:cancel": {
        const [cancel] = request as SignInOrderRequest<"inf:sign-ins:cancel">;
        this.running.get(cancel.signInId)?.abort.abort();
        if (this.forging === cancel.signInId) this.options.forges.cancel();
        return { ok: true };
      }
      case "inf:sign-ins:remove": {
        const [remove] = request as SignInOrderRequest<"inf:sign-ins:remove">;
        if (!this.options.accounts.vault.get(remove.accountId))
          throw new Error("This computer has no account with that id.");
        // Claude's own login goes too when Firstmate made it here; the home says which.
        const signedOut = await this.options.accounts.vault.remove(remove.accountId);
        void this.report();
        return { ok: true, ...(signedOut ? { login: signedOut.login } : {}) };
      }
      case "inf:sign-ins:forge": {
        const [forge] = request as SignInOrderRequest<"inf:sign-ins:forge">;
        // Asked again: it is already running.
        if (this.forging !== forge.signInId)
          this.forge(forge.signInId, (step) => this.options.forges.start(forge.host, step));
        return { ok: true };
      }
      case "inf:sign-ins:forge-cli": {
        const [cli] = request as SignInOrderRequest<"inf:sign-ins:forge-cli">;
        // The rows it changed reach the home as its sign-ins, whole; the answer carries no token.
        return this.options.forges.signInWithCli(cli.host);
      }
      case "inf:sign-ins:forge-key": {
        const [input] = request as SignInOrderRequest<"inf:sign-ins:forge-key">;
        // The key is kept only in this computer's store; the answer names the host, never the key.
        return this.options.forges.signInWithKey(input);
      }
      case "inf:sign-ins:forge-browser": {
        const [{ signInId, ...input }] =
          request as SignInOrderRequest<"inf:sign-ins:forge-browser">;
        if (this.forging !== signInId)
          this.forge(signInId, (step) => this.options.forges.startBrowser(input, step));
        return { ok: true };
      }
      case "inf:sign-ins:forge-out": {
        const [out] = request as SignInOrderRequest<"inf:sign-ins:forge-out">;
        // The rows it changed reach the home as its sign-ins, whole.
        this.options.forges.signOut(out.host);
        return { ok: true };
      }
      case "inf:sign-ins:custom-address": {
        const [baseUrl] = request as SignInOrderRequest<"inf:sign-ins:custom-address">;
        return this.options.accounts.vault.customAddress(baseUrl);
      }
      case "inf:sign-ins:custom-profiles":
        return customCapabilityProfiles();
      case "inf:sign-ins:custom-review": {
        const [baseUrl, mode, pem] = request as SignInOrderRequest<"inf:sign-ins:custom-review">;
        return this.options.accounts.vault.customReview(baseUrl, mode, pem);
      }
      case "inf:sign-ins:custom-connect": {
        const [input] = request as SignInOrderRequest<"inf:sign-ins:custom-connect">;
        // The key stays in the draft on this computer. The answer is a view, never the key.
        return this.options.accounts.vault.customConnect(input);
      }
      case "inf:sign-ins:custom-check": {
        const [draftId, modelId] = request as SignInOrderRequest<"inf:sign-ins:custom-check">;
        return this.options.accounts.vault.customCheck(draftId, modelId);
      }
      case "inf:sign-ins:custom-discover": {
        const [draftId] = request as SignInOrderRequest<"inf:sign-ins:custom-discover">;
        return this.options.accounts.vault.customDiscover(draftId);
      }
      case "inf:sign-ins:custom-cancel": {
        const [draftId] = request as SignInOrderRequest<"inf:sign-ins:custom-cancel">;
        this.options.accounts.vault.customCancel(draftId);
        return { ok: true };
      }
      case "inf:sign-ins:custom-save": {
        const [draftId, paused] = request as SignInOrderRequest<"inf:sign-ins:custom-save">;
        const record = await this.options.accounts.vault.customSave(draftId, paused);
        const view = this.options.accounts.vault
          .customViews()
          .find((entry) => entry.accountId === record.id);
        if (!view) throw new Error("This connection could not be saved.");
        void this.report();
        return view;
      }
      case "inf:sign-ins:custom-recheck": {
        const [accountId] = request as SignInOrderRequest<"inf:sign-ins:custom-recheck">;
        const view = await this.options.accounts.vault.customRecheck(accountId);
        void this.report();
        return view;
      }
      case "inf:sign-ins:keep-going": {
        const [keep] = request as SignInOrderRequest<"inf:sign-ins:keep-going">;
        const { vault } = this.options.accounts;
        if (!vault.get(keep.accountId))
          throw new Error("This computer has no account with that id.");
        // Saved only here; the vault refuses a provider that sells no credits.
        vault.setKeepGoingOnCredits(keep.accountId, keep.on);
        // A spent allowance held after a refusal ends when the provider says
        // its credits answer: the switch is what was missing.
        const row = this.options.accounts
          .allowance()
          ?.providers.find((provider) => provider.accountId === keep.accountId);
        if (keep.on && row?.credits?.state === "available")
          vault.noteCreditsAvailable(keep.accountId);
        void this.report();
        return { ok: true };
      }
      case "inf:sign-ins:rename": {
        const [rename] = request as SignInOrderRequest<"inf:sign-ins:rename">;
        this.ownAccount(rename.accountId);
        this.options.accounts.vault.rename(rename.accountId, rename.label);
        void this.report();
        return { ok: true };
      }
      case "inf:sign-ins:set-enabled": {
        const [set] = request as SignInOrderRequest<"inf:sign-ins:set-enabled">;
        this.ownAccount(set.accountId);
        // A paused account keeps its sign-in; the home's routing skips it.
        this.options.accounts.vault.setEnabled(set.accountId, set.enabled);
        void this.report();
        return { ok: true };
      }
      case "inf:sign-ins:pin": {
        const [pin] = request as SignInOrderRequest<"inf:sign-ins:pin">;
        if (pin.accountId !== null) this.ownAccount(pin.accountId);
        // The vault refuses an account of another provider.
        this.options.accounts.vault.setPin(pin.providerId, pin.accountId);
        void this.report();
        return { ok: true };
      }
      case "inf:sign-ins:read-allowance":
        // The reading reaches the home as this computer's sign-ins, whole.
        await this.options.accounts.readAllowance("demand");
        return { ok: true };
      default:
        throw new Error(`${channel} is not a request this computer answers.`);
    }
  }

  /** Refuses an account this computer does not hold. */
  private ownAccount(accountId: string): void {
    if (!this.options.accounts.vault.get(accountId))
      throw new Error("This computer has no account with that id.");
  }

  private start(start: SignInOrderRequest<"inf:sign-ins:start">[0]): void {
    const { signInId } = start;
    const running: Running = { abort: new AbortController(), prompts: new Map() };
    this.running.set(signInId, running);
    const stop = () => {
      for (const waiting of running.prompts.values())
        waiting.reject(new Error("Sign in cancelled"));
      running.prompts.clear();
    };
    running.abort.signal.addEventListener("abort", stop, { once: true });
    const bridge: AuthInteractionBridge = {
      prompt: (prompt: AuthPromptView) =>
        new Promise<string>((resolve, reject) => {
          if (running.abort.signal.aborted) {
            reject(new Error("Sign in cancelled"));
            return;
          }
          running.prompts.set(prompt.promptId, { resolve, reject });
          void this.step(signInId, { kind: "prompt", prompt });
        }),
      notify: (notice) => void this.step(signInId, { kind: "notice", notice }),
      // The link is the captain's to open, at home; nothing opens here.
      openExternal: async () => {},
      signal: running.abort.signal,
    };
    const { vault } = this.options.accounts;
    const run = (async () => {
      let ended: SignInStep;
      try {
        let accountId = start.accountId;
        if (accountId) {
          if (!vault.get(accountId)) throw new Error("This computer has no account with that id.");
          await vault.signIn(accountId, bridge);
        } else accountId = (await vault.add(start.providerId, start.type, bridge)).id;
        ended = { kind: "ended", outcome: "signed-in", accountId };
      } catch (error) {
        ended = running.abort.signal.aborted
          ? { kind: "ended", outcome: "cancelled" }
          : { kind: "ended", outcome: "failed", error: messageOf(error) };
      } finally {
        running.abort.signal.removeEventListener("abort", stop);
        this.running.delete(signInId);
      }
      await this.step(signInId, ended);
      if (ended.outcome !== "signed-in") return;
      // The new row at once; its own model list and allowance once each lands.
      await this.report();
      if (ended.accountId) void this.options.accounts.readModels?.(ended.accountId);
      await this.options.accounts.readAllowance("sign-in");
    })();
    this.ending.add(run);
    void run.finally(() => this.ending.delete(run));
  }

  /**
   * Starts the sign-in where projects live here; a newer one ends the last,
   * since only one code is ever on screen. Its code and its end go to the
   * home as steps, and the rows it changed as this computer's sign-ins.
   */
  private forge(
    signInId: string,
    start: (step: (step: SignInStep) => void) => Promise<void>,
  ): void {
    this.forging = signInId;
    const run = Promise.resolve()
      .then(() =>
        start((step) => {
          if (step.kind === "ended" && this.forging === signInId) this.forging = undefined;
          void this.step(signInId, step);
        }),
      )
      .catch((error: unknown) => {
        if (this.forging === signInId) this.forging = undefined;
        void this.step(signInId, { kind: "ended", outcome: "failed", error: messageOf(error) });
      });
    this.ending.add(run);
    void run.finally(() => this.ending.delete(run));
  }

  private async step(signInId: string, step: SignInStep): Promise<void> {
    try {
      await this.options.tell("inf:work:sign-in", [{ signInId, step }]);
    } catch (error) {
      // The home is out of reach: nobody can answer, so the sign-in stops.
      this.running.get(signInId)?.abort.abort();
      if (this.forging === signInId) this.options.forges.cancel();
      this.options.log(`a sign-in step did not reach the home: ${messageOf(error)}`);
    }
  }
}

/**
 * A Codex or Grok account's own list, for the home's rail; nothing for any
 * other account. An id the home's reading would refuse (`accountList`'s
 * bounds in src/shared/signIns.ts) is left out here, so one odd id never
 * makes the whole answer unreadable at the home.
 */
function accountListOf(accounts: ComputerAccounts, accountId: string): { accountList?: string[] } {
  const list = accounts.accountList?.(accountId);
  if (!list) return {};
  const ids = list.filter((id) => id.length >= 1 && id.length <= ACCOUNT_LIST_ID_MAX);
  return { accountList: ids.slice(0, SERVED_MODELS_MAX) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This computer's own sign-ins, as the helper holds them once loaded. */
export type HeldSignIns = {
  accounts: ComputerAccounts;
  forges: HeldForges;
  host: SignInHost;
  close: () => Promise<void>;
};

/**
 * Loads this computer's own sign-ins: its store, its allowance and the host
 * that answers the home's sign-in orders. The helper loads it with the first
 * order about sign-ins, the first conversation, or at start when it already
 * holds a sign-in, so a computer that signs in to nothing never loads it.
 */
export async function startSignIns(options: {
  dataDir: string;
  /** Whether it runs from a packaged app. */
  packaged: boolean;
  tell: Tell;
  log: (line: string) => void;
  /** This Mac's saved passwords, read only without asking (`ComputerAccountsOptions.keychain`). */
  keychain?: HostKeychain;
  accounts?: (options: ComputerAccountsOptions) => Promise<ComputerAccounts>;
  forges?: (options: ComputerForgesOptions) => HeldForges;
}): Promise<HeldSignIns> {
  let host: SignInHost | undefined;
  const accounts = await (options.accounts ?? startComputerAccounts)({
    dataDir: options.dataDir,
    packaged: options.packaged,
    // A new reading is news to the home.
    onAllowance: () => void host?.report(),
    // A settled model list is news too: OpenRouter's models arrive with it.
    onModels: () => void host?.report(),
    log: options.log,
    ...(options.keychain ? { keychain: options.keychain } : {}),
  });
  const forges = (options.forges ?? startComputerForges)({
    dataDir: options.dataDir,
    packaged: options.packaged,
    // A sign-in made or gone, or its health, is news to the home.
    onChange: () => void host?.report(),
    log: options.log,
  });
  host = new SignInHost({ accounts, forges, tell: options.tell, log: options.log });
  const held = host;
  // A cut-off a turn here met, or its end, is news to the home: a task it
  // runs here waits on it there (docs/helper.md, "Its own sign-ins").
  const unhear = accounts.vault.onCutOffChange(() => void held.report());
  return {
    accounts,
    forges,
    host: held,
    close: async () => {
      unhear();
      await held.close();
      forges.close();
      accounts.close();
    },
  };
}
