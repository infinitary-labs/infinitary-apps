import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingFrom } from "@shared/envSettings";
import {
  DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
  type LocalOrchestratorSetting,
  type LocalOrchestratorSource,
  type LocalOrchestratorView,
  localOrchestratorSettingSchema,
} from "@shared/localOrchestrator";
import { createModelRuntime } from "../pi/modelRuntime";
import { type OllamaProfile, prepareOllama } from "../pi/ollamaProfile";
import { LOCAL_OUTPUT_TOKENS, ollamaStream } from "../pi/ollamaStream";
import type { ModelRuntime } from "../pi/types";

/**
 * The dev-only local-model orchestrator (roadmap 1.7, captain decisions
 * 2026-09-21): an UNPACKAGED dev checkout may point the Firstmate seat - and
 * only that seat - at a local OpenAI-compatible endpoint (Ollama or its
 * equivalent), so a local model can be felt in the orchestrator's chair
 * before any collected label is evaluated. It sits beside the Claude-client
 * resolution of 1.6 as a second dev-only path and is not a feature: no
 * terms, nothing collected, no surface in a shipped build.
 *
 * The gate is the build, not a flag: `resolveLocalOrchestrator` answers
 * nothing for a packaged app whatever the environment or the settings row
 * says, and `LocalOrchestratorService.set` refuses outright, so a notarized
 * release cannot grow a way to re-point its orchestrator. Unpackaged, the
 * seat is asked for in one of two ways that make the same choice: the
 * Settings row (General -> the dev section: a switch, the endpoint, the
 * model) when it is on, else the two environment variables below for a
 * headless run; a third variable is the bearer for an endpoint that wants
 * one (Ollama ignores it).
 *
 * The seat is its own `ModelRuntime` over a models.json the core writes
 * under `userData/dev/local-orchestrator/` - the same custom-provider shape
 * the e2e mock provider uses - never the person's app-scoped models.json.
 * Crewmates never see the model: it is outside the routing pool, the slot
 * record and the quota catalog, and the Firstmate's persisted model pin is
 * untouched, so turning the seat off restores exactly what was there.
 */

export const LOCAL_ORCHESTRATOR_PROVIDER_ID = "local";
/** The settings a headless run names (`INFINITARY_<NAME>`, or the older `FM3000_<NAME>`; `@shared/envSettings`). */
export const LOCAL_ORCHESTRATOR_URL_SETTING = "LOCAL_ORCHESTRATOR_URL";
export const LOCAL_ORCHESTRATOR_MODEL_SETTING = "LOCAL_ORCHESTRATOR_MODEL";
export const LOCAL_ORCHESTRATOR_KEY_SETTING = "LOCAL_ORCHESTRATOR_KEY";

/** The one feed line when the seat goes: the pin was never touched, so the usual model is back. */
export const LOCAL_ORCHESTRATOR_OFF_LINE =
  "Your first mate is back on its usual model; the local seat is off.";
/** What a packaged build answers a write with; the view says `available: false` first. */
export const LOCAL_ORCHESTRATOR_PACKAGED_REFUSAL =
  "The local seat is a dev-checkout control; a packaged build has none.";

export type LocalOrchestratorSpec = {
  /** The OpenAI-compatible base, e.g. `http://localhost:11434/v1`, no trailing slash. */
  baseUrl: string;
  /** The model id the endpoint serves, e.g. `qwen3:8b`. */
  model: string;
  /** The endpoint's host, for the one feed line that says where the seat is. */
  host: string;
  /** The bearer sent with every request; a placeholder where the endpoint ignores it. */
  apiKey: string;
  source: LocalOrchestratorSource;
};

export type LocalOrchestratorGateInput = {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
  /** The Settings row; absent reads as the default, off. */
  setting?: LocalOrchestratorSetting;
};

/**
 * The endpoint and model this checkout asks for, or nothing. A packaged
 * build answers nothing unconditionally - there is deliberately no `=1`
 * override, unlike Observe. Unpackaged, the Settings row speaks when it is
 * on (a bad row seats nothing rather than falling back to the environment,
 * so what the section says is what runs); otherwise the environment does,
 * needing both the URL and the model. Either way the URL must be http(s).
 */
export function resolveLocalOrchestrator(
  input: LocalOrchestratorGateInput,
): LocalOrchestratorSpec | undefined {
  if (input.isPackaged) return undefined;
  const setting = input.setting ?? DEFAULT_LOCAL_ORCHESTRATOR_SETTING;
  if (setting.enabled) return specFrom(setting.baseUrl, setting.model, undefined, "setting");
  const env = input.env ?? {};
  return specFrom(
    settingFrom(env, LOCAL_ORCHESTRATOR_URL_SETTING),
    settingFrom(env, LOCAL_ORCHESTRATOR_MODEL_SETTING),
    settingFrom(env, LOCAL_ORCHESTRATOR_KEY_SETTING),
    "environment",
  );
}

/** Why an enabled row seats nothing, in the dev checkout's own words; null when it would. */
export function localOrchestratorSettingProblem(setting: LocalOrchestratorSetting): string | null {
  if (!setting.enabled) return null;
  if (!parseEndpoint(setting.baseUrl)) {
    return "The endpoint must be an http(s) URL, such as http://localhost:11434/v1.";
  }
  if (!setting.model.trim()) return "Name the model the endpoint serves, such as qwen3:8b.";
  return null;
}

function specFrom(
  url: string | undefined,
  model: string | undefined,
  key: string | undefined,
  source: LocalOrchestratorSource,
): LocalOrchestratorSpec | undefined {
  const parsed = parseEndpoint(url);
  const id = model?.trim();
  if (!parsed || !id) return undefined;
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    model: id,
    host: parsed.host,
    apiKey: key?.trim() || "local",
    source,
  };
}

function parseEndpoint(url: string | undefined): URL | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed;
}

/** The seat's models.json: one custom provider, one model, the shape Pi reads. */
export function localOrchestratorModelsJson(
  spec: LocalOrchestratorSpec,
  profile?: OllamaProfile,
): string {
  return `${JSON.stringify(
    {
      providers: {
        [LOCAL_ORCHESTRATOR_PROVIDER_ID]: {
          name: "Local model (dev)",
          baseUrl: spec.baseUrl,
          api: "openai-completions",
          apiKey: spec.apiKey,
          models: [
            {
              id: spec.model,
              name: spec.model,
              ...(profile
                ? {
                    contextWindow: profile.contextWindow,
                    maxTokens: LOCAL_OUTPUT_TOKENS,
                    reasoning: profile.thinking,
                    input: profile.vision ? ["text", "image"] : ["text"],
                  }
                : {}),
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export type LocalOrchestratorSeat = {
  model: { provider: string; id: string };
  runtime: ModelRuntime;
  host: string;
  source: LocalOrchestratorSource;
  /** Lazy: a stopped server must not stop the app booting or Settings opening. */
  prepare?: () => Promise<void>;
};

/** Where the seat's files live; regenerated on every boot or write that asks for it. */
export function localOrchestratorDir(userData: string): string {
  return join(userData, "dev", "local-orchestrator");
}

/**
 * The seat: a runtime of its own over the written models.json, so the
 * Firstmate binds to it the way it binds to the base runtime for any custom
 * provider, and nothing else in the app reads the file.
 */
export async function createLocalOrchestratorSeat(
  spec: LocalOrchestratorSpec,
  paths: { userData: string },
): Promise<LocalOrchestratorSeat> {
  const dir = localOrchestratorDir(paths.userData);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, localOrchestratorModelsJson(spec), { mode: 0o600 });
  const runtime = await createModelRuntime({
    authPath: join(dir, "auth.json"),
    modelsPath,
    modelsStorePath: join(dir, "models-store.json"),
  });
  let preparation: Promise<void> | undefined;
  const prepare = async () => {
    const profile = await prepareOllama(spec);
    if (!profile) return;
    writeFileSync(modelsPath, localOrchestratorModelsJson(spec, profile), { mode: 0o600 });
    const model = runtime.getModel(LOCAL_ORCHESTRATOR_PROVIDER_ID, spec.model);
    if (!model) throw new Error("The local model is not available.");
    runtime.registerProvider(LOCAL_ORCHESTRATOR_PROVIDER_ID, {
      api: "ollama-chat",
      baseUrl: spec.baseUrl,
      apiKey: spec.apiKey,
      streamSimple: ollamaStream(spec, profile),
      models: [
        {
          ...model,
          api: "ollama-chat",
          contextWindow: profile.contextWindow,
          maxTokens: LOCAL_OUTPUT_TOKENS,
          reasoning: profile.thinking,
          input: profile.vision ? ["text", "image"] : ["text"],
        },
      ],
    });
  };
  return {
    model: { provider: LOCAL_ORCHESTRATOR_PROVIDER_ID, id: spec.model },
    runtime,
    prepare: () =>
      (preparation ??= prepare().catch((error) => {
        preparation = undefined;
        throw error;
      })),
    host: spec.host,
    source: spec.source,
  };
}

/** The one feed line when the seat lands: where it is, and that crew are unaffected. */
export function localOrchestratorLine(seat: {
  model: Pick<LocalOrchestratorSeat["model"], "id">;
  host: string;
}): string {
  return `Your first mate is running on ${seat.model.id} at ${seat.host} for this dev checkout; crewmates route as usual.`;
}

export type LocalOrchestratorServiceOptions = {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  paths: { userData: string };
  settings: {
    getLocalOrchestrator(): LocalOrchestratorSetting;
    setLocalOrchestrator(setting: LocalOrchestratorSetting): void;
  };
  broadcastEvent: (event: { type: "firstmate_note"; text: string }) => void;
  /** Hand the Firstmate its new seat, or none; it moves at an idle boundary. */
  onSeat: (seat: LocalOrchestratorSeat | undefined) => void | Promise<void>;
};

/**
 * The one owner of the seat at runtime: it reads the row and the
 * environment, builds the seat, hands it to the Firstmate, and is what
 * Settings reads and writes through. On a packaged build it holds nothing,
 * reads no row, and refuses every write - the section is absent because
 * `view().available` is false, not because the window chose to hide it.
 */
export class LocalOrchestratorService {
  private current: LocalOrchestratorSeat | undefined;
  /** The identity of the spec the current seat was built from; undefined = no seat. */
  private key: string | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalOrchestratorServiceOptions) {}

  async boot(): Promise<LocalOrchestratorSeat | undefined> {
    const spec = this.resolve();
    if (!spec) return undefined;
    this.current = await createLocalOrchestratorSeat(spec, this.options.paths);
    this.key = specKey(spec);
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: localOrchestratorLine(this.current),
    });
    return this.current;
  }

  seat(): LocalOrchestratorSeat | undefined {
    return this.current;
  }

  view(): LocalOrchestratorView {
    if (this.options.isPackaged) {
      return {
        available: false,
        setting: DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
        active: null,
        problem: null,
      };
    }
    const setting = this.options.settings.getLocalOrchestrator();
    return {
      available: true,
      setting,
      active: this.current
        ? { model: this.current.model.id, host: this.current.host, source: this.current.source }
        : null,
      problem: localOrchestratorSettingProblem(setting),
    };
  }

  /**
   * The Settings write: persist the row, rebuild the seat when what it
   * resolves to changed, and hand the Firstmate the result. One feed line
   * per change, the same line the boot writes.
   */
  set(setting: LocalOrchestratorSetting): Promise<LocalOrchestratorView> {
    // A runtime build yields. Serialize writes so an older build cannot
    // reseat Firstmate after a later switch-off or different model choice.
    const write = this.writes.then(() => this.apply(setting));
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private async apply(setting: LocalOrchestratorSetting): Promise<LocalOrchestratorView> {
    if (this.options.isPackaged) throw new Error(LOCAL_ORCHESTRATOR_PACKAGED_REFUSAL);
    const next = localOrchestratorSettingSchema.parse({
      enabled: setting.enabled,
      baseUrl: setting.baseUrl.trim(),
      model: setting.model.trim(),
    });
    this.options.settings.setLocalOrchestrator(next);
    const spec = this.resolve();
    const key = spec ? specKey(spec) : undefined;
    if (key !== this.key) {
      const seat = spec ? await createLocalOrchestratorSeat(spec, this.options.paths) : undefined;
      await this.options.onSeat(seat);
      this.current = seat;
      this.key = key;
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: this.current ? localOrchestratorLine(this.current) : LOCAL_ORCHESTRATOR_OFF_LINE,
      });
    }
    return this.view();
  }

  private resolve(): LocalOrchestratorSpec | undefined {
    return resolveLocalOrchestrator({
      isPackaged: this.options.isPackaged,
      env: this.options.env,
      setting: this.options.settings.getLocalOrchestrator(),
    });
  }
}

function specKey(spec: LocalOrchestratorSpec): string {
  return `${spec.source}\n${spec.baseUrl}\n${spec.model}\n${spec.apiKey}`;
}
