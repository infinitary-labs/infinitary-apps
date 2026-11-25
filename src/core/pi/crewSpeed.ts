import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { CrewSpeed, SpeedSelection } from "@shared/crewSpeed";
import type { SessionSpec } from "../session/session";
import { instructionsInInput } from "./codexInstructions";
import type { ModelRuntime } from "./types";

const TIERS: Record<CrewSpeed, string> = {
  standard: "default",
  fast: "priority",
  ultrafast: "ultrafast",
};

/** No inference from a plan label or model name, and never change the account/model. */
export function speedSelection(
  requested: CrewSpeed,
  capabilities: readonly CrewSpeed[] | undefined,
): SpeedSelection {
  if (requested === "standard" || capabilities?.includes(requested))
    return { requested, sent: requested };
  return {
    requested,
    sent: "standard",
    reason: capabilities
      ? "this account does not offer that speed for this model"
      : "speed availability for this account and model is unknown or out of date",
  };
}

/**
 * A per-session facade: sharing an account runtime never shares a crew policy with the seat.
 * Every Codex request passes through it, so it also moves the request's
 * instructions to where the service reuses them (`instructionsInInput`).
 */
export function speedRuntime(
  runtime: ModelRuntime,
  spec: SessionSpec,
  capabilities: (
    accountId: string | undefined,
    modelId: string,
  ) => readonly CrewSpeed[] | undefined | Promise<readonly CrewSpeed[] | undefined>,
): ModelRuntime {
  let lastDecision = "";
  let lastConfirmed = "";
  const stream: ModelRuntime["streamSimple"] = (model, context, options) => {
    if (model.provider !== "openai-codex") return runtime.streamSimple(model, context, options);
    const output = createAssistantMessageEventStream();
    void (async () => {
      const ref = { provider: model.provider, id: model.id };
      let requested: CrewSpeed = "standard";
      let unavailable = false;
      try {
        requested = (await spec.speed?.requested(ref)) ?? "standard";
      } catch {
        unavailable = true;
      }
      const accountId = spec.binding.accountId;
      let offered: readonly CrewSpeed[] | undefined;
      if (requested !== "standard") {
        try {
          offered = await capabilities(accountId, model.id);
        } catch {
          /* An unreadable capability is unknown, never a request failure. */
        }
      }
      let selection = speedSelection(requested, offered);
      if (unavailable)
        selection = {
          requested: "standard",
          sent: "standard",
          reason: "the saved speed choice could not be read",
        };
      const record = () => {
        const decision = JSON.stringify([
          model.id,
          selection.requested,
          selection.sent,
          selection.reason,
        ]);
        if (selection.confirmed) {
          const key = `${decision}:${selection.confirmed}`;
          if (key === lastConfirmed) return;
          lastConfirmed = key;
        } else {
          if (decision === lastDecision) return;
          lastDecision = decision;
          lastConfirmed = "";
        }
        const label = { ...ref, name: model.name };
        spec.speed?.record(label, selection);
      };
      record();
      const run = async (): Promise<boolean> => {
        let rejected = false;
        let emitted = false;
        let start: AssistantMessageEvent | undefined;
        const source = runtime.streamSimple(model, context, {
          ...options,
          onPayload: async (payload, served) => {
            const changed = await options?.onPayload?.(payload, served);
            const body = changed ?? payload;
            if (body && typeof body === "object" && !Array.isArray(body))
              return {
                ...instructionsInInput(body as Record<string, unknown>),
                service_tier: TIERS[selection.sent],
              };
            return body;
          },
          onProviderStreamEvent: async (data, served) => {
            await options?.onProviderStreamEvent?.(data, served);
            const event = asRecord(data);
            const response = asRecord(event?.response);
            const error = asRecord(response?.error) ?? asRecord(event?.error) ?? event;
            // Only an explicit tier refusal before any output permits another request.
            // Network failures and unknown provider errors never replay work.
            if (
              (event?.type === "error" || event?.type === "response.failed") &&
              [
                "service_tier_not_supported",
                "service_tier_unavailable",
                "invalid_service_tier",
              ].includes(String(error?.code))
            )
              rejected = true;
            if (
              (event?.type === "response.completed" || event?.type === "response.done") &&
              typeof response?.service_tier === "string"
            ) {
              selection = { ...selection, confirmed: response.service_tier };
              record();
            }
          },
        });
        for await (const event of source) {
          if (event.type === "start") {
            start = event;
            continue;
          }
          if (
            event.type === "error" &&
            rejected &&
            !emitted &&
            selection.sent !== "standard" &&
            !options?.signal?.aborted
          )
            return false;
          if (start) {
            output.push(start);
            start = undefined;
          }
          emitted = true;
          // Pi's rates do not price subscription acceleration. Retain tokens, not misleading dollar estimates.
          if (
            selection.sent !== "standard" ||
            selection.confirmed === "ultrafast" ||
            selection.confirmed === "priority"
          )
            hideCost(event);
          output.push(event);
        }
        output.end(await source.result());
        return true;
      };
      if (!(await run())) {
        selection = {
          requested,
          sent: "standard",
          reason: "the provider explicitly refused the faster speed before producing output",
        };
        record();
        await run();
      }
    })().catch((error: unknown) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      output.push({ type: "error", reason: "error", error: message });
      output.end(message);
    });
    return output;
  };
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "streamSimple") return stream;
      if (property === "completeSimple")
        return (...args: Parameters<typeof stream>) => stream(...args).result();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function hideCost(event: AssistantMessageEvent): void {
  const message =
    event.type === "done"
      ? event.message
      : event.type === "error"
        ? event.error
        : "partial" in event
          ? event.partial
          : undefined;
  if (message?.usage)
    message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
