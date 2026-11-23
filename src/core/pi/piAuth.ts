import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthNotice, AuthPromptView, ProviderView } from "@shared/providers";
import {
  BEDROCK_PROVIDER_ID,
  isOfferedProvider,
  isPiProvider,
  PROVIDER_CATALOG,
} from "@shared/providers";
import type { AppPaths } from "../paths";
import { createModelRuntime } from "./modelRuntime";

/**
 * The BASE runtime owner (decision D-5, account-broker era): one
 * ModelRuntime over userData/auth/auth.json + models.json. Since the
 * AccountVault landed, provider sign-ins live in per-account stores
 * (src/main/pi/accountVault.ts); this base runtime serves the provider
 * catalog metadata, custom providers from models.json (dev/e2e), and
 * account-less sessions. The auth file is kept 0600 and its contents never
 * leave the main process.
 */

export type AuthInteractionBridge = {
  /** Relay a login prompt to the user; resolve with the entered value. */
  prompt: (prompt: AuthPromptView) => Promise<string>;
  /** Surface login progress (auth urls, device codes) in the shell. */
  notify: (notice: AuthNotice) => void;
  /** Open a vetted auth url in the default browser. Must reject if it does not. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Stops the sign-in from outside, wherever it is: waiting on a prompt, on a
   * browser, or polling a code. A backend that cannot stop its flow ignores it.
   */
  signal?: AbortSignal;
};

export class PiAuthService {
  private constructor(
    readonly modelRuntime: ModelRuntime,
    private readonly paths: Pick<AppPaths, "authDir" | "authPath" | "modelsPath">,
  ) {}

  static async create(
    paths: Pick<AppPaths, "authDir" | "authPath" | "modelsPath">,
  ): Promise<PiAuthService> {
    mkdirSync(paths.authDir, { recursive: true, mode: 0o700 });
    const modelRuntime = await createModelRuntime({
      authPath: paths.authPath,
      modelsPath: paths.modelsPath,
    });
    const service = new PiAuthService(modelRuntime, paths);
    service.enforceAuthFileMode();
    return service;
  }

  /** Credentials are secrets: the auth file must never be group/world readable. */
  enforceAuthFileMode(): void {
    if (existsSync(this.paths.authPath)) {
      chmodSync(this.paths.authPath, 0o600);
    }
  }

  /**
   * Models served by custom providers (models.json) on the base runtime -
   * its only contribution to availability since the broker landed: catalog
   * provider credentials live in the vault, one store per account, and a
   * leftover legacy credential here must not create a shadow account.
   *
   * A provider counts only when models.json defines it or the auth file
   * saves its key. Pi also serves a built-in provider whose key it finds in
   * the process environment, and a Windows app keeps its whole environment
   * (hostEnv.ts): a key such as OPENAI_API_KEY there outlives an uninstall
   * and a data wipe, and counting it hid the sign-in screen on a fresh
   * install with no account added (docs/first-launch.md).
   */
  customProviderModels(): { provider: string; id: string }[] {
    const defined = this.modelsJsonProviders();
    const counts = (provider: string) => {
      if (defined.has(provider)) return true;
      const source = this.modelRuntime.getProviderAuthStatus(provider).source;
      return source === "stored" || source === "runtime";
    };
    return this.modelRuntime
      .getAvailableSnapshot()
      .filter(
        (model) =>
          model.provider !== "anthropic" &&
          !isOfferedProvider(model.provider) &&
          counts(model.provider),
      )
      .map((model) => ({ provider: model.provider, id: model.id }));
  }

  private modelsJsonRead: { stamp: string; providers: ReadonlySet<string> } | undefined;

  /**
   * The provider ids the app's models.json defines, reread only when the
   * file changes since routing asks on every pass. Pi's own loader is not
   * exported, so this parses as it does: `//` line comments and trailing
   * commas allowed. A file Pi could not load defines nothing for it either.
   */
  private modelsJsonProviders(): ReadonlySet<string> {
    let stamp: string;
    try {
      const stat = statSync(this.paths.modelsPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return new Set();
    }
    if (this.modelsJsonRead?.stamp === stamp) return this.modelsJsonRead.providers;
    let providers: ReadonlySet<string> = new Set();
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.paths.modelsPath, "utf8")
          .replace(/^\uFEFF/, "")
          .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
          .replace(
            /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
            (match, tail?: string) => tail ?? (match[0] === '"' ? match : ""),
          ),
      );
      const list =
        parsed && typeof parsed === "object"
          ? (parsed as { providers?: unknown }).providers
          : undefined;
      if (list && typeof list === "object") providers = new Set(Object.keys(list));
    } catch {}
    this.modelsJsonRead = { stamp, providers };
    return providers;
  }

  /**
   * Whether an account-less session here has any model to run on: a
   * models.json provider, or anything else this runtime holds a credential
   * for. With none, such a session fails before its first answer.
   */
  servesAnyModel(model?: { provider: string; id: string }): boolean {
    if (model)
      return this.customProviderModels().some(
        (ref) => ref.provider === model.provider && ref.id === model.id,
      );
    return this.modelRuntime.getAvailableSnapshot().length > 0;
  }

  /**
   * What the crew reads of an account-less session here: whether it serves
   * any model, and which, so a model a task's user named that it serves is
   * the one it opens on.
   */
  accountless(): {
    accountlessServes: (model?: { provider: string; id: string }) => boolean;
    accountlessModels: () => { provider: string; id: string }[];
  } {
    return {
      accountlessServes: (model) => this.servesAnyModel(model),
      accountlessModels: () =>
        this.modelRuntime
          .getAvailableSnapshot()
          .map((model) => ({ provider: model.provider, id: model.id })),
    };
  }

  /** Provider rows for the catalog entries Pi serves; the rest is its backend's. */
  providers(): ProviderView[] {
    const views: ProviderView[] = [];
    for (const entry of PROVIDER_CATALOG) {
      if (entry.backend !== "pi") continue;
      const provider = this.modelRuntime.getProvider(entry.id);
      if (!provider) continue;
      const authTypes: ("oauth" | "api_key")[] = [];
      const auth = provider.auth as { oauth?: unknown; apiKey?: { login?: unknown } };
      if (auth.oauth) authTypes.push("oauth");
      if (auth.apiKey && (auth.apiKey as { login?: unknown }).login) authTypes.push("api_key");
      const connected =
        entry.id !== BEDROCK_PROVIDER_ID && this.modelRuntime.hasConfiguredAuth(entry.id);
      views.push({
        id: entry.id,
        name: entry.name,
        tier: entry.tier,
        authTypes,
        connected,
        ...(connected
          ? { activeAuthType: this.modelRuntime.isUsingOAuth(entry.id) ? "oauth" : "api_key" }
          : {}),
        billedPerToken: entry.id === BEDROCK_PROVIDER_ID,
      });
    }
    return views;
  }

  hasConfiguredAuth(providerId: string): boolean {
    return this.modelRuntime.hasConfiguredAuth(providerId);
  }

  /**
   * Resolve request auth for a configured provider. Pi refreshes OAuth
   * tokens inside getAuth (locked, min validity 5 minutes) and persists
   * the rotated credential to the app-scoped auth file.
   */
  async resolveAuth(providerId: string): Promise<ResolvedProviderAuth | undefined> {
    try {
      const result = await this.modelRuntime.getAuth(providerId);
      if (!result) return undefined;
      const headers = result.auth.headers
        ? Object.fromEntries(
            Object.entries(result.auth.headers).flatMap(([key, value]) =>
              typeof value === "string" ? [[key, value] as const] : [],
            ),
          )
        : undefined;
      return {
        ...(typeof result.auth.apiKey === "string" ? { apiKey: result.auth.apiKey } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(typeof result.auth.baseUrl === "string" ? { baseUrl: result.auth.baseUrl } : {}),
        usingOAuth: this.modelRuntime.isUsingOAuth(providerId),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Native catalog models for quota-managed Pi providers (not OpenRouter).
   *
   * Provider-wide on purpose: an unmeasurable provider must still list its
   * models so routing reads unknown quota as unknown rather than zero
   * (quota/fetchQuota.test.ts). Sign-in gating belongs to availableModels()
   * and, for the Subscriptions surface, to the renderer.
   *
   * `extra` are the accounts' own runtimes. Pi only fetches the live pi.dev
   * overlay for a provider it holds a credential for, and credentials live
   * in the vault - so the base runtime alone would keep this catalog frozen
   * on pi-ai's bundled data while the picker moved on.
   */
  catalogModels(extra: ModelRuntime[] = []): QuotaCatalogModel[] {
    const quotaProviders = new Set(
      PROVIDER_CATALOG.filter((entry) => entry.id !== "openrouter" && isPiProvider(entry.id)).map(
        (entry) => entry.id,
      ),
    );
    const seen = new Set<string>();
    const models: QuotaCatalogModel[] = [];
    for (const runtime of [this.modelRuntime, ...extra]) {
      for (const model of runtime.getModels()) {
        if (!quotaProviders.has(model.provider)) continue;
        const key = `${model.provider}/${model.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({ provider: model.provider, id: model.id, name: model.name });
      }
    }
    return models;
  }
}

export type ResolvedProviderAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  usingOAuth: boolean;
};

export type QuotaCatalogModel = {
  provider: string;
  id: string;
  name: string;
};
