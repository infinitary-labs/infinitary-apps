import type { ClassifierContext } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { getBuiltinClassifierModel } from "@earendil-works/pi-ai/providers/all";
import type { OpenRouterDecisionOffering } from "@shared/decisions";
import type { FmUsage } from "@shared/events";
import {
  BODY_LIMIT_BYTES,
  type QuotaHttp,
  QuotaTransportError,
  readBoundedBody,
} from "../quota/http";
import type { ModelRuntime } from "./types";

// Pi's classifier catalog has no question-capability field. These models
// support the app's six-way choice; Span answers only yes/no. Unknown models
// stay out until their choice contract is established.
const makers: Record<string, string> = {
  "typesafe/jev-1.13": "TypeSafe",
  "~typesafe/jev-latest": "TypeSafe",
  "jaredpalmer/kev-4b": "Jared Palmer",
  "upstage/solar-decide": "Upstage",
  "inception/mercury-decide:free": "Inception",
  "togethercomputer/tev1-4b-experimental": "Together",
  "openai/gpt-6-luna-decisions": "OpenAI",
};

export function openRouterDecisionModels(runtime: ModelRuntime): OpenRouterDecisionOffering[] {
  return runtime.getModelsOfType("classifier", "openrouter").flatMap((model) => {
    const vendor = makers[model.id];
    return vendor && model.api === "typesafe-system-one"
      ? [
          {
            id: model.id,
            name: model.name.replace(/^[^:]+:\s*/, ""),
            vendor,
            inputPrice: model.cost.input,
          },
        ]
      : [];
  });
}

type ClassifierResult = Awaited<ReturnType<ModelRuntime["classify"]>>;

/** What the reply says about itself: the model that answered and what the call cost. */
function reportedBy(bytes: Uint8Array): {
  model?: string;
  cost?: number;
  input?: boolean;
  output?: boolean;
} {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const { model, usage } = body as { model?: unknown; usage?: unknown };
  const cost = usage && typeof usage === "object" ? (usage as { cost?: unknown }).cost : undefined;
  const counts = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const present = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return {
    input: present(counts.input_tokens),
    output: present(counts.output_tokens),
    ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
  };
}

/**
 * The call's burn for the ledger: Pi's token counts (System One reports no
 * cache categories, so they stay unknown), priced by the cost the reply
 * reported, else by Pi's catalog estimate. A zero estimate proves nothing
 * and is left out, as for any Pi message (`usageFromMessage`).
 */
function usageOf(
  result: ClassifierResult,
  reported: ReturnType<typeof reportedBy>,
): FmUsage | undefined {
  const reportedCost = reported.cost;
  const counts: FmUsage = result.usage
    ? {
        ...(reported.input ? { input: result.usage.input } : {}),
        ...(reported.output ? { output: result.usage.output } : {}),
      }
    : {};
  if (reportedCost !== undefined) return { ...counts, cost: reportedCost, costSource: "reported" };
  if (!result.usage) return undefined;
  if (!reported.input || !reported.output) return Object.keys(counts).length ? counts : undefined;
  const { cost } = result.usage;
  return cost.total > 0
    ? {
        ...counts,
        cost: cost.total,
        costParts: { input: cost.input, output: cost.output },
        costSource: "listed-prices",
      }
    : counts;
}

export async function classifyOpenRouter(
  runtime: ModelRuntime,
  id: string,
  context: Parameters<ModelRuntime["classify"]>[1],
  signal: AbortSignal,
  timeoutMs: number,
  baseUrl?: string,
) {
  const model = runtime
    .getModelsOfType("classifier", "openrouter")
    .find((entry) => entry.id === id);
  if (!model || !openRouterDecisionModels(runtime).some((entry) => entry.id === id))
    return undefined;
  const observer = classifierObserver(
    fetch,
    baseUrl ? new URL("systemone", `${baseUrl.replace(/\/+$/u, "")}/`).href : undefined,
  );
  const result = await runtime.classify(model, context, {
    signal,
    timeoutMs,
    maxRetries: 0,
    fetch: observer.fetch,
  });
  return observer.result(result);
}

/** One bounded metadata observer for both native System One paths, never an answer parser. */
function classifierObserver(fetcher: typeof fetch, target?: string) {
  let status: number | undefined;
  let failure: string | undefined;
  let reported: ReturnType<typeof reportedBy> = {};
  return {
    fetch: (async (input, init) => {
      try {
        const response = await fetcher(target ?? input, init);
        status = response.status;
        const body = await readBoundedBody(response, BODY_LIMIT_BYTES, init?.signal ?? undefined);
        if (response.ok) reported = reportedBy(body);
        return new Response(response.body ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        failure = error instanceof QuotaTransportError ? error.failure : "network";
        throw error;
      }
    }) as typeof fetch,
    result(result: ClassifierResult) {
      const usage = usageOf(result, reported);
      return {
        result,
        status,
        oversized: failure === "oversized",
        failure,
        ...(reported.model ? { served: reported.model } : {}),
        ...(usage ? { usage } : {}),
      };
    },
  };
}

/** Retain the approved native rate as configuration; Pi owns multiplication. */
export const TYPESAFE_INPUT_PRICE_PER_MTOK = 0.042;
export async function classifyTypeSafe(input: {
  model: string;
  endpoint: string;
  key: string;
  context: ClassifierContext;
  signal: AbortSignal;
  timeoutMs: number;
  http: QuotaHttp;
}) {
  const observer = classifierObserver(
    (async (url, init) => {
      // The app-owned private key enters only this bounded request. Pi receives
      // no ambient credential or configuration source.
      const response = await input.http(String(url), {
        method: init?.method,
        headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" },
        body: new TextEncoder().encode(String(init?.body ?? "")),
        signal: init?.signal ?? input.signal,
        responseType: "bytes",
      });
      return new Response(
        (response.bytes ? new Uint8Array(response.bytes) : undefined) ??
          JSON.stringify(response.json) ??
          "",
        { status: response.status, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
    input.endpoint,
  );
  const known = getBuiltinClassifierModel("typesafe", "jev-latest");
  const result = await classify(
    { ...known, id: input.model, cost: { ...known.cost, input: TYPESAFE_INPUT_PRICE_PER_MTOK } },
    input.context,
    {
      apiKey: "firstmate-decision-availability-only",
      env: {},
      maxRetries: 0,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      fetch: observer.fetch,
    },
  );
  return observer.result(result);
}
