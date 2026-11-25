import { createHash } from "node:crypto";
import type { AssistantMessage, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CustomListedModel } from "@shared/customApi";
import {
  approvedCustomApiCertificates,
  reviewCustomApiCertificates,
} from "./customApiCertificates";
import { type CustomCapabilities, customPiModel } from "./customApiModels";
import { CustomApiError, normalizeCustomApiBase } from "./customApiPolicy";
import {
  assertCustomModelLimits,
  type CustomApiProtocol,
  type CustomModelLimits,
  type CustomResponsesPolicy,
  customApiProfile,
  generateCustomApi,
} from "./customApiProtocol";
import {
  type CustomApiTransport,
  type CustomApiTransportOptions,
  createCustomApiTransport,
} from "./customApiTransport";
import { piReasoningCapabilities } from "./reasoning";

const CHECK_TOKEN = "FIRSTMATE_CUSTOM_API_OK";
const CHECK_DEADLINE_MS = 60_000;
const CHECK_OUTPUT_TOKENS = 128;
/** A tiny, offline grayscale PNG of two digits. The expected answer never enters text. */
const CHECK_PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAEgAAAA4CAAAAAB7pOFaAAAAQUlEQVR4nO3MMQoAIAwEQf//aUWwkBRGQWycrZLiptRLFRCoH6Psj4FAJ1AMBFpBsQwAgWZoewACgUCPodNAX0MNfTy05vgsiX4AAAAASUVORK5CYII=";

export type CustomConnectionCandidate = CustomApiTransportOptions & {
  protocol: CustomApiProtocol;
  model: string;
  limits: CustomModelLimits;
  /** Opaque account-owner revision, not a key hash or a credential reference. */
  credentialRevision: string;
  storage: CustomResponsesPolicy;
  capabilities?: CustomCapabilities;
  cacheRetention?: "none" | "short" | "long";
  /** A connection file says the model reads no pictures: the check sends none. */
  textOnly?: boolean;
};
export type CustomModelProof = {
  profile: ReturnType<typeof customApiProfile>;
  fingerprint: string;
  checkedAt: number;
  /** Absent on older saved checks; bound to this proof's fingerprint. */
  readsPictures?: boolean;
};

/**
 * The owner may persist this non-secret fingerprint. Any address, mode, key
 * revision, header, address exception, model, limit, protocol, profile, certificate or policy
 * change makes an old proof unusable. Identity/label and role placement are
 * separate. A secret header's value is bound through the opaque revision,
 * never hashed here; a connection without headers keeps its earlier fingerprint.
 */
export function customModelFingerprint(candidate: CustomConnectionCandidate): string {
  assertCustomModelLimits(candidate.limits);
  approvedCustomApiCertificates(candidate.certificates, candidate.mode);
  if (!candidate.credentialRevision.trim()) throw new CustomApiError("credential");
  return createHash("sha256")
    .update(
      JSON.stringify({
        address: normalizeCustomApiBase(candidate.baseUrl, candidate.mode).baseUrl,
        mode: candidate.mode,
        credentialKind: candidate.credential.kind,
        credentialRevision: candidate.credentialRevision,
        protocol: candidate.protocol,
        profile: customApiProfile(candidate.protocol),
        model: candidate.model,
        context: candidate.limits.context,
        output: candidate.limits.output,
        certificates: candidate.certificates
          ? reviewCustomApiCertificates(candidate.certificates.pem).map(
              (certificate) => certificate.fingerprint,
            )
          : [],
        storage: candidate.storage,
        capabilities: candidate.capabilities,
        cacheRetention: candidate.cacheRetention ?? "none",
        // A connection without an exception keeps its earlier fingerprint.
        ...(candidate.exception ? { exception: true } : {}),
        // A typed model line keeps its earlier fingerprint too.
        ...(candidate.textOnly ? { textOnly: true } : {}),
        ...(candidate.headers?.length
          ? {
              headers: candidate.headers.map((header) => ({
                name: header.name.toLowerCase(),
                secret: header.secret,
                ...(header.secret ? {} : { value: header.value }),
              })),
            }
          : {}),
      }),
    )
    .digest("hex");
}

export function customModelProofMatches(
  candidate: CustomConnectionCandidate,
  proof: CustomModelProof | undefined,
): boolean {
  try {
    return (
      proof?.profile === customApiProfile(candidate.protocol) &&
      proof.fingerprint === customModelFingerprint(candidate)
    );
  } catch {
    return false;
  }
}

/**
 * Two text requests per offered level, then one optional tool-picture request; no automatic retry, fixed synthetic input
 * and one in-memory echo action. The caller discloses possible charges before
 * invoking this. No real prompts, project data, work tools or executable action
 * enter the check. Cancellation cannot return a late activation proof.
 */
export async function checkCustomApiModel(
  candidate: CustomConnectionCandidate,
  signal?: AbortSignal,
  makeTransport: (
    options: CustomApiTransportOptions,
  ) => CustomApiTransport = createCustomApiTransport,
): Promise<CustomModelProof> {
  // Capture a candidate revision once; UI edits while the check runs cannot
  // silently change the second request or the proof it returns.
  const captured: CustomConnectionCandidate = {
    ...candidate,
    credential: { ...candidate.credential },
    ...(candidate.headers ? { headers: candidate.headers.map((header) => ({ ...header })) } : {}),
    limits: { ...candidate.limits },
    storage: { ...candidate.storage },
    ...(candidate.capabilities ? { capabilities: structuredClone(candidate.capabilities) } : {}),
    ...(candidate.certificates
      ? {
          certificates: {
            pem: candidate.certificates.pem,
            fingerprints: [...candidate.certificates.fingerprints],
          },
        }
      : {}),
  };
  const fingerprint = customModelFingerprint(captured);
  const transport = makeTransport({ ...captured, generation: "check" });
  const deadline = AbortSignal.timeout(CHECK_DEADLINE_MS);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const base = {
      protocol: captured.protocol,
      model: captured.model,
      limits: captured.limits,
      storage: captured.storage,
      capabilities: captured.capabilities,
      cacheRetention: captured.cacheRetention,
      sessionId: fingerprint,
      maxOutput: Math.min(CHECK_OUTPUT_TOKENS, captured.limits.output),
    };
    const tools: Tool[] = [
      {
        name: "firstmate_echo",
        description: "Echo the synthetic connection-check text. Does not read or write anything.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", enum: [CHECK_TOKEN] } },
          required: ["text"],
          additionalProperties: false,
        } as Tool["parameters"],
      },
    ];
    const context = normalizeContext({
      systemPrompt: `This is a synthetic API connection check. Call firstmate_echo once with text ${CHECK_TOKEN}. After its result, reply with only ${CHECK_TOKEN}. Do not call any other action.`,
      tools,
      messages: [{ role: "user", content: "Run the connection check.", timestamp: 0 }],
    });
    const levels = piReasoningCapabilities(customPiModel(base))?.levels ?? [];
    for (const reasoning of levels.length ? levels : [undefined]) {
      const first = await generateCustomApi(
        transport,
        { ...base, reasoning, context },
        cancellation,
      );
      const calls = first.content.filter((part): part is ToolCall => part.type === "toolCall");
      const call = calls[0];
      if (
        calls.length !== 1 ||
        !call ||
        call.name !== "firstmate_echo" ||
        Object.keys(call.arguments).length !== 1 ||
        call.arguments.text !== CHECK_TOKEN
      )
        throw new CustomApiError("incompatible");
      const second = await generateCustomApi(
        transport,
        {
          ...base,
          reasoning,
          context: {
            ...context,
            messages: [
              ...context.messages,
              first,
              {
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: CHECK_TOKEN }],
                isError: false,
                timestamp: Date.now(),
              },
            ],
          },
        },
        cancellation,
      );
      if (
        second.content.some((part) => part.type === "toolCall") ||
        textOf(second).trim() !== CHECK_TOKEN
      )
        throw new CustomApiError("incompatible");
      if (cancellation.aborted) throw new CustomApiError(signal?.aborted ? "cancelled" : "timeout");
    }
    let readsPictures = false;
    if (!captured.textOnly)
      try {
        const definition = customPiModel(base);
        const pictureCall: AssistantMessage = {
          role: "assistant",
          api: definition.api,
          provider: definition.provider,
          model: definition.id,
          content: [
            {
              type: "toolCall",
              id: "picture_check",
              name: "firstmate_echo",
              arguments: { text: CHECK_TOKEN },
            },
          ],
          stopReason: "toolUse",
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const messages: Message[] = [
          { role: "user", content: "Read the tool's picture.", timestamp: 0 },
          pictureCall,
          {
            role: "toolResult",
            toolCallId: "picture_check",
            toolName: "firstmate_echo",
            isError: false,
            timestamp: 0,
            content: [
              { type: "text", text: "Picture to read:" },
              { type: "image", mimeType: "image/png", data: CHECK_PICTURE },
            ],
          },
        ];
        const picture = await generateCustomApi(
          transport,
          {
            ...base,
            readsPictures: true,
            context: normalizeContext({
              systemPrompt:
                "This is a synthetic API connection check. Read the two digits in the picture returned by firstmate_echo. Reply with only those digits, or unknown if you cannot read it.",
              tools,
              messages,
            }),
          },
          cancellation,
        );
        readsPictures =
          !picture.content.some((part) => part.type === "toolCall") &&
          textOf(picture).trim() === "47";
      } catch {
        // An optional picture refusal leaves text proof intact; caller cancel never does.
      }
    if (signal?.aborted) throw new CustomApiError("cancelled");
    return {
      profile: customApiProfile(candidate.protocol),
      fingerprint,
      checkedAt: Date.now(),
      readsPictures,
    };
  } catch (error) {
    if (cancellation.aborted) throw new CustomApiError(signal?.aborted ? "cancelled" : "timeout");
    throw error instanceof CustomApiError ? error : new CustomApiError("malformed");
  } finally {
    transport.close();
  }
}

// The limit fields OpenAI-compatible servers commonly publish in their model
// list (OpenRouter, Together, Groq, Mistral, Fireworks, DeepInfra, vLLM and
// others), on the entry itself or under its provider/metadata object. An input
// limit stands in for the context window, which can only make admission
// stricter. A bare `max_tokens` is ambiguous (some servers mean the window), so
// it is read as the output limit only on an object that also states
// `max_input_tokens`, the shape Anthropic's model list publishes.
const LISTED_CONTEXT = [
  "context_length",
  "context_window",
  "max_context_length",
  "max_model_len",
  "max_input_tokens",
] as const;
const LISTED_OUTPUT = ["max_completion_tokens", "max_output_tokens"] as const;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function listedLimit(entry: Record<string, unknown>, fields: readonly string[]) {
  for (const source of [entry, entry.top_provider, entry.metadata]) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    for (const field of fields) {
      const value: unknown = record[field];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    }
    if (fields === LISTED_OUTPUT && positiveInteger(record.max_input_tokens)) {
      const value: unknown = record.max_tokens;
      if (positiveInteger(value)) return value;
    }
  }
  return undefined;
}

/**
 * Optional, bounded discovery of model IDs and the context/output limits the
 * server states for them. Manual models and saved metadata stay caller-owned.
 */
export async function listCustomApiModels(
  transport: CustomApiTransport,
  signal?: AbortSignal,
): Promise<CustomListedModel[]> {
  try {
    const response = await transport.request("models", undefined, signal);
    const payload: unknown = await response.json();
    // `{ data: [...] }` is the common shape; some servers answer the bare list.
    const data = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object"
        ? (payload as { data?: unknown }).data
        : undefined;
    if (!Array.isArray(data)) throw new CustomApiError("malformed");
    if (data.length > 1000) throw new CustomApiError("oversized");
    const models = new Map<string, CustomListedModel>();
    for (const entry of data) {
      const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control characters in untrusted model identifiers.
      const controls = typeof id === "string" && /[\u0000-\u001f\u007f]/.test(id);
      if (typeof id !== "string" || !id.trim() || id.length > 256 || controls) {
        throw new CustomApiError("malformed");
      }
      if (models.has(id)) continue;
      const context = listedLimit(entry as Record<string, unknown>, LISTED_CONTEXT);
      let output = listedLimit(entry as Record<string, unknown>, LISTED_OUTPUT);
      // An output limit that leaves no room for input is not a usable limit.
      if (context !== undefined && output !== undefined && output >= context) output = undefined;
      models.set(id, {
        id,
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
      });
    }
    // Deliberately discard endpoints, executable settings, headers, prices and
    // capabilities. Only IDs and stated limits are kept, and a listing cannot
    // check or activate a model.
    transport.assertSafeOutput([...models.keys()]);
    return [...models.values()];
  } catch (error) {
    throw error instanceof CustomApiError ? error : new CustomApiError("malformed");
  }
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
