import { createHash } from "node:crypto";

/** Only the selected endpoint is probed. No CLI, host credentials or server lifecycle. */
export type LocalEndpoint = { baseUrl: string; model: string; apiKey: string };
export type OllamaProfile = {
  alias: string;
  contextWindow: number;
  thinking: boolean;
  vision: boolean;
};

type Show = {
  parameters?: string;
  modelfile?: string;
  model_info?: Record<string, unknown>;
  capabilities?: string[];
};
type ModelTag = { name: string; digest: string };
type RunningModel = { name: string; context_length: number; size: number; size_vram: number };

// 64k is the floor, not an assumption about available memory, and not a
// guess at the fixed part's size. The first mate's and a crewmate's fixed
// parts are held under the boundaries tests/firstmate-fixed-context.test.ts
// and tests/crewmate-fixed-context.test.ts derive from this floor.
// Ollama's loader admits each candidate against its OWN GPU/Metal memory;
// /ps must confirm the allocation.
export const OLLAMA_MIN_CONTEXT = 65_536;
export const OLLAMA_TARGET_CONTEXT = 65_536;
const PROBE_MS = 5_000;
const LOAD_MS = 90_000;
const canonical = (name: string): string => {
  const short = name.replace(/^registry\.ollama\.ai\//, "").replace(/^library\//, "");
  return short.split("/").at(-1)?.includes(":") ? short : `${short}:latest`;
};

export function ollamaContext(parameters: string | undefined): number | undefined {
  const match = parameters?.match(/^\s*num_ctx\s+(\d+)\s*$/m);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sourceOf(show: Show): string | undefined {
  return show.modelfile?.match(/^FROM\s+(.+)$/m)?.[1]?.trim();
}

/** Content identity prevents a base-tag update from reusing yesterday's weights. */
function aliasFor(base: string, digest: string, context: number): string {
  const hash = createHash("sha256")
    .update(`v1\n${canonical(base)}\n${digest}\n${context}`)
    .digest("hex");
  return `fm3000-context-${hash.slice(0, 32)}:latest`;
}

/**
 * An alias is a cache of a model configuration, not a new user model choice.
 * Successful aliases are retained/reused (including across app installs).
 * Never delete an existing alias or overwrite a mismatched one; only a failed
 * candidate created by this call may be removed. The original tag is untouched.
 */
export async function prepareOllama(
  endpoint: LocalEndpoint,
  fetcher: typeof fetch = fetch,
): Promise<OllamaProfile | undefined> {
  const root = endpoint.baseUrl.replace(/\/v1\/?$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${endpoint.apiKey}`,
  };
  const request = async (path: string, body?: unknown, timeout = PROBE_MS, method = "POST") => {
    return fetcher(`${root}/api/${path}`, {
      method: body === undefined ? "GET" : method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
  };
  const json = async <T>(path: string, body?: unknown, timeout?: number): Promise<T> => {
    const response = await request(path, body, timeout);
    if (!response.ok) throw new Error(`Local model request failed (${response.status}).`);
    return (await response.json()) as T;
  };
  try {
    const version = await request("version");
    // An OpenAI-compatible server need not implement Ollama's native API.
    if (version.status === 404 || version.status === 405) return undefined;
    if (!version.ok) throw new Error("The local model server is not available.");
    const identity = (await version.json().catch(() => ({}))) as { version?: unknown };
    if (typeof identity.version !== "string" || !/^\d+\.\d+\.\d+/.test(identity.version))
      return undefined;

    const base = await json<Show>("show", { model: endpoint.model });
    const tags = await json<{ models: ModelTag[] }>("tags");
    const tag = tags.models.find((row) => canonical(row.name) === canonical(endpoint.model));
    const architecture = base.model_info?.["general.architecture"];
    const trained =
      typeof architecture === "string"
        ? base.model_info?.[`${architecture}.context_length`]
        : undefined;
    if (
      !tag?.digest ||
      !sourceOf(base) ||
      typeof trained !== "number" ||
      !Number.isSafeInteger(trained)
    ) {
      throw new Error(
        "The local model does not report enough information to set up safely. Update Ollama and try again.",
      );
    }
    // Earlier servers can ignore unknown flags. The native no-truncation
    // contract was verified on 0.34.2; never silently downgrade that boundary.
    const [major = 0, minor = 0, patch = 0] = identity.version.split(/[.-]/).map(Number);
    if (major === 0 && (minor < 34 || (minor === 34 && patch < 2))) {
      throw new Error(
        "The local model needs Ollama 0.34.2 or newer so a long conversation cannot lose its instructions. Update Ollama and retry.",
      );
    }
    if (!base.capabilities?.includes("tools")) {
      throw new Error(
        "This local model cannot use the actions your first mate needs. Choose a model that supports tools.",
      );
    }
    if (trained < OLLAMA_MIN_CONTEXT) {
      throw new Error(
        "This local model cannot hold your first mate's instructions and an answer. Choose a model with a larger context window.",
      );
    }
    const desired = Math.min(trained, OLLAMA_TARGET_CONTEXT);
    const candidates = [...new Set([desired, OLLAMA_MIN_CONTEXT])];
    // Reuse a previously admitted smaller configuration before trying a larger
    // allocation again at every launch. An updated base digest starts fresh.
    const installed = new Set(tags.models.map((row) => canonical(row.name)));
    candidates.sort(
      (a, b) =>
        Number(installed.has(aliasFor(endpoint.model, tag.digest, b))) -
        Number(installed.has(aliasFor(endpoint.model, tag.digest, a))),
    );
    for (const context of candidates) {
      const alias = aliasFor(endpoint.model, tag.digest, context);
      let created = false;
      const existing = await request("show", { model: alias });
      if (existing.status === 404) {
        // The create API is the Modelfile FROM + PARAMETER mechanism, without
        // spawning a CLI or writing into the user's model installation.
        await json(
          "create",
          {
            model: alias,
            from: endpoint.model,
            parameters: { num_ctx: context },
            stream: false,
          },
          LOAD_MS,
        );
        created = true;
      } else if (!existing.ok) {
        throw new Error(
          "Your first mate could not prepare the local model. Check that Ollama allows model creation and try again.",
        );
      }
      const configured = await json<Show>("show", { model: alias });
      if (
        ollamaContext(configured.parameters) !== context ||
        sourceOf(configured) !== sourceOf(base)
      ) {
        throw new Error(
          "The local model's saved configuration does not match. Your first mate left it unchanged; choose another model or update Ollama.",
        );
      }
      try {
        // Preload the SAME chat runner/options used for inference. In Ollama
        // 0.34, shift:false can select a different engine; preloading through
        // generate would measure the wrong allocation and discard its cache.
        // Empty messages load only: no inference or invented prompt.
        await json(
          "chat",
          {
            model: alias,
            messages: [],
            stream: false,
            keep_alive: "5m",
            truncate: false,
            shift: false,
          },
          LOAD_MS,
        );
        const running = await json<{ models: RunningModel[] }>("ps");
        const allocated = running.models.find((row) => canonical(row.name) === alias);
        if (
          allocated?.context_length === context &&
          allocated.size > 0 &&
          allocated.size_vram >= allocated.size * 0.95
        ) {
          return {
            alias,
            contextWindow: context,
            thinking: base.capabilities.includes("thinking"),
            vision: base.capabilities.includes("vision"),
          };
        }
      } catch {
        // A smaller candidate still has to fit the full contract and be
        // admitted by the server. Never fall back to the unsafe original tag.
      }
      if (created) {
        await request("chat", { model: alias, messages: [], keep_alive: 0 }, LOAD_MS).catch(
          () => undefined,
        );
        await request("delete", { model: alias }, PROBE_MS, "DELETE").catch(() => undefined);
      }
    }
    throw new Error(
      "The local model does not fit in the server's available graphics memory with enough room for your first mate. Close other models or choose a smaller model, then retry.",
    );
  } catch (error) {
    // Native errors can contain the private alias or filesystem paths. Those
    // are implementation details, never the user's model name or instructions.
    if (
      error instanceof Error &&
      /^(This local model|The local model|Your first mate could not prepare)/.test(error.message)
    )
      throw error;
    throw new Error(
      "Your first mate could not reach or prepare the local model. Check that Ollama is running and the selected model is installed, then retry.",
    );
  }
}
