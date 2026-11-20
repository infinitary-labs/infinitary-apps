import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isCustomApiProvider } from "@shared/customApi";
import { BEDROCK_PROVIDER_ID } from "@shared/providers";
import {
  type AccountBackend,
  type AccountBinding,
  type AccountLoginRequest,
  type AccountRef,
  type AccountStatus,
  statusFromHealth,
} from "../accounts/accountBackend";
import type { CredentialHealth, RenewalOutcome, RenewReason } from "../accounts/credentialHealth";
import { createQuotaHttp, type QuotaHttp } from "../quota/http";
import {
  bedrockProfileIdentity,
  bedrockProfiles,
  bedrockSourceProfile,
  signInBedrockProfile,
} from "./bedrockProfile";
import { COPILOT_PROVIDER_ID, copilotEnterpriseHost, copilotGitHubLogin } from "./copilotMeter";
import { CustomApiAccountOwner } from "./customApiAccounts";
import { CustomApiCatalog, customCatalog } from "./customApiModels";
import { createModelRuntime } from "./modelRuntime";
import { buildAuthInteraction } from "./piAuthInteraction";

/**
 * How long a Pi login may sit with no prompt, notice, or result. Codex's
 * first step is a select; if that never surfaces, Connect used to stay on
 * "Connecting..." forever. Short enough that a hung load looks like a
 * failure, long enough that a slow catalog attach is not one.
 */
export const LOGIN_IDLE_TIMEOUT_MS = 15_000;
/**
 * A human-paced browser flow; room to finish, not forever. A device code
 * lasts as long as the provider's own answer says instead, and the flow
 * ends itself then.
 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type PiAccountBackendOptions = {
  loginIdleTimeoutMs?: number;
  loginTimeoutMs?: number;
  /**
   * The app-scoped models.json every account runtime reads, so a custom
   * provider or a per-provider override there serves an account exactly as
   * it serves the base runtime. Each account still keeps its own pi.dev
   * overlay store beside its auth file. Absent, an account reads a
   * models.json of its own (the pre-first-launch layout).
   */
  modelsPath?: string;
  /** A runtime's model list settled. The computer tells its home which models it serves. */
  onCatalogRefreshed?: () => void;
  /** How a Copilot sign-in reads its GitHub username; production reads GitHub. */
  http?: QuotaHttp;
  bedrockUrl?: string;
  awsCli?: string;
};

/**
 * The Pi account backend: the incumbent, unchanged in behaviour and now
 * stated as one implementation of the account-backend seam, so a second
 * backend is a registration rather than a fork of the vault.
 *
 * One account = one Pi auth file, hence one ModelRuntime. Pi mints and
 * refreshes the credential inside that file; Infinitary owns only the path and
 * its 0600 mode.
 */
export class PiAccountBackend implements AccountBackend {
  readonly id = "pi" as const;
  readonly custom: CustomApiAccountOwner;
  private readonly runtimes = new Map<string, Promise<ModelRuntime>>();
  /** Runtimes that finished creating, for synchronous snapshot reads. */
  private readonly ready = new Map<string, ModelRuntime>();
  /**
   * The in-flight work of each login (swallowed), surviving an aborted
   * race: settled() awaits it so post-abort cleanup runs after the work
   * that could re-create store files.
   */
  private readonly pendingLogins = new Map<string, Promise<void>>();
  private readonly loginIdleTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly modelsPath: string | undefined;
  private readonly onCatalogRefreshed: (() => void) | undefined;
  private readonly http: QuotaHttp;
  private readonly bedrockUrl?: string;
  private readonly awsCli?: string;
  private activeBedrockLogin = false;
  private readonly unavailableProfiles = new Set<string>();

  bedrockProfileUnavailable(accountId: string, dir: string): boolean {
    return this.unavailableProfiles.has(accountId) || bedrockRecheckPending(dir);
  }
  /**
   * The GitHub username each Copilot account signed in as, read once when
   * its sign-in lands, and reported as the account's identity so the vault
   * names a new account by it (INF-838).
   */
  private readonly signedInAs = new Map<string, string>();

  constructor(options: PiAccountBackendOptions = {}) {
    this.loginIdleTimeoutMs = options.loginIdleTimeoutMs ?? LOGIN_IDLE_TIMEOUT_MS;
    this.loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.modelsPath = options.modelsPath;
    this.bedrockUrl = options.bedrockUrl;
    this.awsCli = options.awsCli;
    // Profiles, names and prices read every Pi account's refreshed catalog,
    // and the live catalog a custom connection's protocol needs, kept beside
    // the app's models.json. With no app home (tests) nothing is fetched.
    this.custom = new CustomApiAccountOwner(
      undefined,
      options.modelsPath
        ? new CustomApiCatalog({
            modelsStorePath: join(dirname(options.modelsPath), "custom-catalog-store.json"),
            runtimes: () => [...this.ready.values()],
          })
        : { want: async () => {}, models: () => customCatalog([...this.ready.values()]) },
    );
    this.onCatalogRefreshed = options.onCatalogRefreshed;
    // The platform's fetch as it stands at each read, not at construction.
    this.http = options.http ?? createQuotaHttp((input, init) => fetch(input, init));
  }

  authTypes(providerId?: string): ("oauth" | "api_key")[] {
    if (providerId === BEDROCK_PROVIDER_ID) return ["api_key"];
    return ["oauth", "api_key"];
  }

  async login(request: AccountLoginRequest): Promise<void> {
    const bedrock = request.providerId === BEDROCK_PROVIDER_ID;
    if (bedrock && this.activeBedrockLogin)
      throw new Error("Amazon Bedrock sign-in is already in progress.");
    if (bedrock) this.activeBedrockLogin = true;
    const abort = new AbortController();
    let sawInteraction = false;
    const fail = (error: Error) => {
      if (!abort.signal.aborted) abort.abort(error);
    };
    const mark = () => {
      sawInteraction = true;
    };
    let idle: ReturnType<typeof setTimeout> | undefined;
    const total = setTimeout(() => {
      fail(new Error("Sign-in timed out. Try again."));
    }, this.loginTimeoutMs);
    // Stopped from outside: the flow ends wherever it waits.
    const stopped = () => fail(new Error("Sign in cancelled"));
    if (request.bridge.signal?.aborted) stopped();
    request.bridge.signal?.addEventListener("abort", stopped, { once: true });
    // Pi's Copilot sign-in first asks for a GitHub Enterprise host in a text
    // prompt. The app answers it from the person's typed choice, or the host
    // the account signed in to before; blank is github.com (INF-838).
    let enterpriseAsked = false;
    const enterpriseHost =
      request.providerId === COPILOT_PROVIDER_ID
        ? (request.enterpriseHost ?? copilotEnterpriseHost(authPathIn(request.dir)) ?? "")
        : undefined;
    const interaction = buildAuthInteraction(
      request.providerId,
      request.accountId,
      {
        prompt: async (prompt) => {
          mark();
          return request.bridge.prompt(prompt);
        },
        notify: (notice) => {
          mark();
          // The code lasts as long as the provider said, and Pi's poll
          // ends at that moment: the app's own limit no longer applies.
          if (notice.kind === "device_code" && notice.expiresAt !== undefined) clearTimeout(total);
          request.bridge.notify(notice);
        },
        openExternal: request.bridge.openExternal,
      },
      {
        onFatal: fail,
        answer: (prompt) => {
          if (enterpriseHost === undefined || enterpriseAsked || prompt.type !== "text")
            return undefined;
          enterpriseAsked = true;
          mark();
          return enterpriseHost;
        },
      },
    );
    const work = (async () => {
      const runtime = await this.runtimeFor(request);
      // The idle window measures the harness's own login flow, so it opens
      // only once the runtime exists: a slow catalog attach must not be
      // misreported as "Sign-in did not start".
      if (!abort.signal.aborted) {
        idle = setTimeout(() => {
          if (!sawInteraction) fail(new Error("Sign-in did not start. Try again."));
        }, this.loginIdleTimeoutMs);
      }
      const auth = { ...interaction, signal: abort.signal };
      const existing =
        request.again && request.providerId === BEDROCK_PROVIDER_ID
          ? await runtime.getAuth(BEDROCK_PROVIDER_ID)
          : undefined;
      const profile = existing?.env?.AWS_PROFILE;
      const region = existing?.env?.AWS_REGION;
      const recheck = async (
        target: AccountRef,
        current: ModelRuntime,
        region?: string,
        targetProfile = profile,
      ) => {
        let answeredRegion = false;
        await current.login(
          target.providerId,
          request.type,
          region
            ? {
                ...auth,
                prompt: (prompt) => {
                  if (prompt.type === "select")
                    return Promise.resolve(targetProfile ? "profile" : "key");
                  if (prompt.type === "text") {
                    if (answeredRegion && targetProfile) return Promise.resolve(targetProfile);
                    answeredRegion = true;
                    return Promise.resolve(region);
                  }
                  return auth.prompt(prompt);
                },
              }
            : auth,
        );
        enforceAuthFileMode(target.dir);
        abort.signal.throwIfAborted();
        if (targetProfile) {
          rmSync(bedrockRecheckPath(target.dir));
          this.unavailableProfiles.delete(target.accountId);
        }
      };
      const related: {
        account: AccountRef;
        runtime: ModelRuntime;
        region: string;
        profile: string;
      }[] = [];
      if (profile) {
        const profiles = await bedrockProfiles();
        const identity = bedrockProfileIdentity(profiles, profile);
        for (const account of request.relatedAccounts ?? []) {
          const sibling = await this.runtimeFor(account);
          const saved = await sibling.getAuth(BEDROCK_PROVIDER_ID);
          const siblingRegion = saved?.env?.AWS_REGION;
          const siblingProfile = saved?.env?.AWS_PROFILE;
          if (
            siblingProfile &&
            siblingRegion &&
            bedrockProfileIdentity(profiles, siblingProfile) === identity
          )
            related.push({
              account,
              runtime: sibling,
              region: siblingRegion,
              profile: siblingProfile,
            });
        }
        abort.signal.throwIfAborted();
        // The named AWS identity can change for several rows at once. Mark every old list first.
        for (const account of [request, ...related.map((entry) => entry.account)])
          writeFileSync(bedrockRecheckPath(account.dir), "", { mode: 0o600 });
        auth.notify({ type: "progress", message: "Opening your AWS sign-in." });
        await signInBedrockProfile(bedrockSourceProfile(profiles, profile), auth, this.awsCli);
      }
      await recheck(request, runtime, region);
      for (const sibling of related) {
        try {
          await recheck(sibling.account, sibling.runtime, sibling.region, sibling.profile);
          await request.onRelatedRechecked?.(sibling.account.accountId);
        } catch {
          // A sibling's old models stay withheld. Check the remaining regions within this sign-in.
          if (abort.signal.aborted) break;
        }
      }
      if (request.providerId === COPILOT_PROVIDER_ID) {
        const login = await copilotGitHubLogin(authPathIn(request.dir), this.http, abort.signal);
        if (login) this.signedInAs.set(request.accountId, login);
        else this.signedInAs.delete(request.accountId);
      }
    })();
    const swallowed = work.then(
      () => undefined,
      () => undefined,
    );
    this.pendingLogins.set(request.accountId, swallowed);
    void swallowed.then(() => {
      if (bedrock) this.activeBedrockLogin = false;
      if (this.pendingLogins.get(request.accountId) === swallowed) {
        this.pendingLogins.delete(request.accountId);
      }
    });
    try {
      await raceAbort(abort.signal, work);
    } finally {
      if (idle) clearTimeout(idle);
      clearTimeout(total);
      request.bridge.signal?.removeEventListener("abort", stopped);
    }
  }

  /** In-flight login or runtime-creation work has fully settled. */
  async settled(accountId: string): Promise<void> {
    await this.pendingLogins.get(accountId);
    await this.runtimes.get(accountId)?.then(
      () => undefined,
      () => undefined,
    );
  }

  async logout(account: AccountRef): Promise<undefined> {
    if (isCustomApiProvider(account.providerId)) {
      await this.custom.forget(account.accountId);
      return;
    }
    const runtime = await this.runtimeFor(account);
    await runtime.logout(account.providerId);
  }

  /**
   * Resolve IS renewal (spec §11.2.2): `getAuth` refreshes OAuth inside
   * the account's store, locked, and persists the rotation. API keys do
   * not expire - `unsupported` is the honest ceiling.
   */
  async renew(account: AccountRef, _reason: RenewReason): Promise<RenewalOutcome> {
    void _reason;
    if (isCustomApiProvider(account.providerId)) return { outcome: "unsupported" };
    try {
      const runtime = await this.runtimeFor(account);
      if (!runtime.hasConfiguredAuth(account.providerId)) return { outcome: "no_credential" };
      if (!runtime.isUsingOAuth(account.providerId)) return { outcome: "unsupported" };
      const result = await runtime.getAuth(account.providerId);
      if (!result) return { outcome: "no_credential" };
      enforceAuthFileMode(account.dir);
      return { outcome: "renewed" };
    } catch {
      return { outcome: "failed" };
    }
  }

  async health(account: AccountRef): Promise<CredentialHealth> {
    if (isCustomApiProvider(account.providerId)) {
      try {
        this.custom.view(account.accountId, "", this.custom.enabled(account.accountId));
        return { state: "healthy", authType: "api_key" };
      } catch {
        return { state: "degraded", reason: "unknown" };
      }
    }
    try {
      const runtime = await this.runtimeFor(account);
      if (!runtime.hasConfiguredAuth(account.providerId)) return { state: "unsigned" };
      const login = this.signedInAs.get(account.accountId);
      return {
        state: "healthy",
        authType: runtime.isUsingOAuth(account.providerId) ? "oauth" : "api_key",
        ...(login ? { identity: { label: login } } : {}),
      };
    } catch {
      return { state: "degraded", reason: "unknown" };
    }
  }

  async status(account: AccountRef): Promise<AccountStatus> {
    return statusFromHealth(await this.health(account));
  }

  binding(account: AccountRef): AccountBinding {
    return {
      via: "pi-runtime",
      authPath: authPathIn(account.dir),
      modelsPath: this.modelsPath ?? modelsPathIn(account.dir),
    };
  }

  forget(accountId: string): void {
    this.unavailableProfiles.delete(accountId);
    this.signedInAs.delete(accountId);
    this.runtimes.delete(accountId);
    this.ready.delete(accountId);
  }

  /** The account's own ModelRuntime (cached): the in-process Pi injection. */
  runtimeFor(account: AccountRef): Promise<ModelRuntime> {
    if (isCustomApiProvider(account.providerId)) return this.custom.runtime(account);
    let pending = this.runtimes.get(account.accountId);
    if (!pending) {
      pending = createRuntime(
        account.dir,
        this.modelsPath,
        this.onCatalogRefreshed,
        account.providerId === BEDROCK_PROVIDER_ID,
        this.bedrockUrl,
        (unavailable) => {
          if (this.runtimes.get(account.accountId) !== pending) return;
          if (unavailable) this.unavailableProfiles.add(account.accountId);
          else this.unavailableProfiles.delete(account.accountId);
        },
      );
      this.runtimes.set(account.accountId, pending);
      pending.then(
        (runtime) => this.ready.set(account.accountId, runtime),
        () => this.runtimes.delete(account.accountId),
      );
    }
    return pending;
  }

  /**
   * A runtime that has finished creating. Selection reads availability
   * synchronously; a runtime still in flight simply contributes nothing.
   */
  settledRuntime(accountId: string): ModelRuntime | undefined {
    return this.custom.settledRuntime(accountId) ?? this.ready.get(accountId);
  }
}

async function createRuntime(
  dir: string,
  appModelsPath?: string,
  onCatalogRefreshed?: () => void,
  bedrockAccount?: boolean,
  bedrockUrl?: string,
  bedrockProfileUnavailable?: (unavailable: boolean) => void,
): Promise<ModelRuntime> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const runtime = await createModelRuntime({
    authPath: authPathIn(dir),
    bedrockAccount,
    bedrockUrl,
    bedrockProfileUnavailable,
    ...(bedrockAccount ? { bedrockRecheckPending: () => bedrockRecheckPending(dir) } : {}),
    modelsPath: appModelsPath ?? modelsPathIn(dir),
    // The overlay cache stays per account whichever models.json is read.
    ...(appModelsPath ? { modelsStorePath: join(dir, "models-store.json") } : {}),
    ...(onCatalogRefreshed ? { onCatalogRefreshed } : {}),
  });
  enforceAuthFileMode(dir);
  return runtime;
}

function bedrockRecheckPath(dir: string): string {
  return join(dir, "bedrock-model-recheck");
}

function bedrockRecheckPending(dir: string): boolean {
  return existsSync(bedrockRecheckPath(dir));
}

export function authPathIn(dir: string): string {
  return join(dir, "auth.json");
}

export function modelsPathIn(dir: string): string {
  return join(dir, "models.json");
}

/** Credentials are secrets: never group/world readable. */
export function enforceAuthFileMode(dir: string): void {
  const authPath = authPathIn(dir);
  if (existsSync(authPath)) chmodSync(authPath, 0o600);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Sign in cancelled");
}

/** Reject as soon as the login is aborted, even if the runtime is still creating. */
function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
