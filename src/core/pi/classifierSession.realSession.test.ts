import { CLASSIFIABLE_KINDS } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import type { SessionBinding } from "../session/session";
import type { ModelRuntime } from "./types";

/**
 * The classifier session's contract test (intelligence-bucket routing S3) -
 * the question's one-shot session (`questionSessionSpec`) opened on Pi's
 * session factory, as the adapted decision model opens it -
 * the same pin the Firstmate, crewmate and supervision sessions carry: the
 * exact production call shape into Pi's createAgentSession. What is load
 * bearing here, and what the S3 design asked for by name:
 *
 * - the session is STATELESS: SessionManager.inMemory, never create/open,
 *   so a classification leaves no session file and nothing to resume;
 * - nothing rolls, so compaction is off, and one retry at most;
 * - the built-ins are disabled AND the custom tool surface is empty, so the
 *   classifier structurally cannot reach a tool - it answers from what it
 *   was given or it abstains;
 * - the served system prompt is the byte-stable instruction;
 * - the model's own maxTokens is clamped to the classifier's cap, and an
 *   unknown model fails loudly rather than binding something else.
 */

const piMocks = vi.hoisted(() => {
  const agentSession = {
    sessionId: "classify-session-1",
    sessionFile: undefined,
    isStreaming: false,
    messages: [] as unknown[],
    model: { provider: "xai", id: "grok-cheap" },
    subscribe: vi.fn((_listener: (event: unknown) => void) => () => {}),
    prompt: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
    setThinkingLevel: vi.fn(),
  };
  return {
    agentSession,
    createAgentSession: vi.fn(async (_spec: Record<string, unknown>) => ({
      session: agentSession,
    })),
    sessionManagerInMemory: vi.fn((cwd: string) => ({ kind: "in-memory", cwd })),
    sessionManagerCreate: vi.fn(() => ({ kind: "created" })),
    sessionManagerOpen: vi.fn(() => ({ kind: "opened" })),
    settingsInMemory: vi.fn((settings: unknown) => ({ kind: "settings", settings })),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: piMocks.createAgentSession,
    SessionManager: {
      inMemory: piMocks.sessionManagerInMemory,
      create: piMocks.sessionManagerCreate,
      open: piMocks.sessionManagerOpen,
    },
    SettingsManager: { inMemory: piMocks.settingsInMemory },
  };
});

const { buildKindClassifierInstruction } = await import("./piResources");
const { CLASSIFIER_MAX_OUTPUT_TOKENS } = await import("../orchestrator/seat");
const { questionSessionSpec } = await import("../session/questionSession");
const { createPiSessionFactory } = await import("./session");

function runtimeWith(model: Record<string, unknown> | undefined): ModelRuntime {
  return { getModel: vi.fn(() => model) } as unknown as ModelRuntime;
}

/** The model as it was actually handed to Pi, after the output clamp. */
function modelOf(call: Record<string, unknown> | undefined): { maxTokens?: number } {
  return (call?.model ?? {}) as { maxTokens?: number };
}

const SPEC = {
  cwd: "/tmp/fm/firstmate",
  agentDir: "/tmp/fm/pi-agent",
  model: { provider: "xai", id: "grok-cheap" },
  // Since S7a the instruction is the QUESTION's, not the factory's: the
  // kind question pins the exact text S3 served, which is what keeps the
  // adapted call - and the `kc1-<sha>` stamp it earns - byte-stable.
  instruction: buildKindClassifierInstruction(),
};

/** The question's session on Pi, as the adapter opens it. */
function createClassifierSession(input: typeof SPEC & { binding: SessionBinding }) {
  return createPiSessionFactory({ agentDir: input.agentDir }).open(
    questionSessionSpec({
      homeDir: input.cwd,
      binding: input.binding,
      model: input.model,
      instruction: input.instruction,
    }),
  );
}

describe("createClassifierSession (the adapted decision model's contract)", () => {
  it("builds one stateless, tool-less session on the byte-stable instruction", async () => {
    piMocks.createAgentSession.mockClear();
    const runtime = runtimeWith({ provider: "xai", id: "grok-cheap", maxTokens: 8192 });
    await createClassifierSession({ ...SPEC, binding: { backend: "pi", runtime } });

    expect(piMocks.sessionManagerInMemory).toHaveBeenCalledWith(SPEC.cwd);
    expect(piMocks.sessionManagerCreate).not.toHaveBeenCalled();
    expect(piMocks.sessionManagerOpen).not.toHaveBeenCalled();
    expect(piMocks.settingsInMemory).toHaveBeenCalledWith({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
      enableInstallTelemetry: false,
    });

    const call = piMocks.createAgentSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.cwd).toBe(SPEC.cwd);
    expect(call.agentDir).toBe(SPEC.agentDir);
    expect(call.noTools).toBe("builtin");
    expect(call.customTools).toEqual([]);
    expect(call.thinkingLevel).toBe("low");
    // No `tools` allowlist: Pi's allowlist gates custom tools too, and there
    // are none to name.
    expect(call).not.toHaveProperty("tools");
    const loader = call.resourceLoader as { getSystemPrompt: () => string };
    expect(loader.getSystemPrompt()).toBe(buildKindClassifierInstruction());
    // And it is the caller's text, served verbatim - not the factory's.
    expect(loader.getSystemPrompt()).toBe(SPEC.instruction);
    // A stateless grain records no contract entry: there is no session file
    // for a corpus to read it back from.
    expect(call.sessionManager).toEqual({ kind: "in-memory", cwd: SPEC.cwd });
  });

  it("clamps the model's output to the classifier's cap, and leaves a smaller one alone", async () => {
    piMocks.createAgentSession.mockClear();
    await createClassifierSession({
      ...SPEC,
      binding: {
        backend: "pi",
        runtime: runtimeWith({ provider: "xai", id: "grok-cheap", maxTokens: 8192 }),
      },
    });
    const clamped = modelOf(piMocks.createAgentSession.mock.calls[0]?.[0]);
    expect(clamped.maxTokens).toBe(CLASSIFIER_MAX_OUTPUT_TOKENS);

    piMocks.createAgentSession.mockClear();
    await createClassifierSession({
      ...SPEC,
      binding: {
        backend: "pi",
        runtime: runtimeWith({ provider: "xai", id: "grok-cheap", maxTokens: 32 }),
      },
    });
    const untouched = modelOf(piMocks.createAgentSession.mock.calls[0]?.[0]);
    expect(untouched.maxTokens).toBe(32);
  });

  it("fails loudly on a model the runtime does not know", async () => {
    await expect(
      createClassifierSession({
        ...SPEC,
        binding: { backend: "pi", runtime: runtimeWith(undefined) },
      }),
    ).rejects.toThrow("Unknown model xai/grok-cheap");
  });

  it("serves only a Pi binding", async () => {
    piMocks.createAgentSession.mockClear();
    await expect(
      createClassifierSession({
        ...SPEC,
        binding: { backend: "claude", accountId: "acct-claude" },
      }),
    ).rejects.toThrow(/cannot serve a claude binding/);
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
  });
});

describe("the classifier instruction", () => {
  const instruction = buildKindClassifierInstruction();

  it("is byte-stable: no interpolation, no machine-specific paths", () => {
    expect(instruction).not.toContain("${");
    expect(instruction).not.toContain("/Users/");
    expect(instruction).not.toContain("/tmp/");
  });

  it("names the classifiable kinds and the abstention, and nothing about what they cost", () => {
    for (const kind of [...CLASSIFIABLE_KINDS, "unclear"]) {
      expect(instruction).toContain(kind);
    }
    // The classifier must not learn what its answer buys, or it starts
    // judging the tier - exactly what the redesign took off the Firstmate.
    expect(instruction).not.toMatch(/\bpremium\b|\btier\b|\bquota\b|\bcheap\b|\bexpensive\b/i);
  });
});
