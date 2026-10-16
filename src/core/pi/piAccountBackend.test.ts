import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor } from "../paths";
import type { AuthInteractionBridge } from "./piAuth";

/**
 * Codex Connect hangs when login never emits a prompt/notice and never
 * settles. The fake runtime here reproduces that hang without talking to
 * OpenAI; the backend must reject instead of leaving the button on
 * "Connecting...".
 */

type LoginFn = (
  providerId: string,
  type: string,
  interaction: {
    prompt: (prompt: {
      type: string;
      message: string;
      options?: readonly { id: string; label: string }[];
    }) => Promise<string>;
    notify: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  },
) => Promise<void>;

const fakes = vi.hoisted(() => ({
  login: undefined as LoginFn | undefined,
  /** Holds runtime creation open, like Pi's slow catalog attach. */
  beforeCreate: undefined as (() => Promise<void>) | undefined,
  createFinished: { value: false },
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  return {
    ModelRuntime: {
      create: vi.fn(
        async (options: { authPath: string; modelsPath: string; modelsStorePath?: string }) => {
          await fakes.beforeCreate?.();
          // Pi writes its store files as part of creation - re-creating the
          // directory if cleanup already removed it, exactly the leak.
          const storePath =
            options.modelsStorePath ??
            options.modelsPath.replace(/models\.json$/, "models-store.json");
          mkdirSync(dirname(storePath), { recursive: true });
          writeFileSync(storePath, "{}");
          fakes.createFinished.value = true;
          return {
            login: vi.fn(
              (providerId: string, type: string, interaction: Parameters<LoginFn>[2]) => {
                if (fakes.login) return fakes.login(providerId, type, interaction);
                writeFileSync(
                  options.authPath,
                  JSON.stringify({ [providerId]: { type: "oauth" } }),
                );
                return Promise.resolve();
              },
            ),
            logout: vi.fn(async () => {}),
            hasConfiguredAuth: () => existsSync(options.authPath),
            isUsingOAuth: () => true,
            getAuth: vi.fn(async () => ({ auth: { apiKey: "resolved-token" } })),
            getAvailableSnapshot: () => [{ provider: "openai-codex", id: "gpt-5.5" }],
            getModel: () => undefined,
          };
        },
      ),
    },
  };
});

const { AccountVault } = await import("./accountVault");
const { PiAccountBackend } = await import("./piAccountBackend");

function bridge(): AuthInteractionBridge & { notices: AuthNotice[]; prompts: AuthPromptView[] } {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  return {
    notices,
    prompts,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return prompt.kind === "select" ? (prompt.options?.[0]?.id ?? "") : "answer";
    },
    notify: (notice) => {
      notices.push(notice);
    },
    openExternal: async () => {},
  };
}

/**
 * A window longer than any test here runs. A test hands it to the timer it
 * is NOT about, so the one it is about decides the outcome: runtime creation
 * sits between the two (the idle window opens only once it finishes), and on
 * a loaded machine two short real timers race each other across it.
 */
const OUT_OF_PLAY_MS = 60_000;

/** Let queued I/O callbacks and promise jobs run; never advances a fake clock. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function vault(idleMs = 30, totalMs = OUT_OF_PLAY_MS) {
  const paths = appPathsFor(scratchDir("infinitary-pi-login-"));
  return AccountVault.create(paths, {
    pi: new PiAccountBackend({ loginIdleTimeoutMs: idleMs, loginTimeoutMs: totalMs }),
  });
}

describe("PiAccountBackend login hang", () => {
  afterEach(() => {
    vi.useRealTimers();
    fakes.login = undefined;
    fakes.beforeCreate = undefined;
    fakes.createFinished.value = false;
  });

  it("rejects a Codex login that never emits a prompt, notice, or result", async () => {
    fakes.login = () => new Promise(() => {});
    const capture = bridge();
    await expect(vault().add("openai-codex", "oauth", capture)).rejects.toThrow(/did not start/i);
    expect(capture.prompts).toHaveLength(0);
    expect(capture.notices).toHaveLength(0);
  });

  it("surfaces Codex's login-method select instead of hanging unseen", async () => {
    let resolveSeen: (prompt: AuthPromptView) => void = () => {};
    const seen = new Promise<AuthPromptView>((resolve) => {
      resolveSeen = resolve;
    });
    fakes.login = async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      });
      return new Promise(() => {});
    };
    const capture = bridge();
    capture.prompt = async (prompt) => {
      capture.prompts.push(prompt);
      resolveSeen(prompt);
      return new Promise(() => {});
    };
    // Both windows run on a clock the test moves, so which one closes first
    // is the sign-in's behavior and not the machine's load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const adding = vault(30, 200).add("openai-codex", "oauth", capture);
    void adding.then(
      () => (settled = true),
      () => (settled = true),
    );
    await expect(seen).resolves.toMatchObject({
      providerId: "openai-codex",
      kind: "select",
    });
    // Idle timeout must not kill a login that already asked the user.
    await vi.advanceTimersByTimeAsync(30);
    await turn();
    expect(settled).toBe(false);
    expect(capture.prompts).toHaveLength(1);
    // Only the whole sign-in's window ends it.
    await vi.advanceTimersByTimeAsync(170);
    await expect(adding).rejects.toThrow(/timed out/i);
  });

  it("an aborted sign-in leaves no orphaned account store once its runtime work settles", async () => {
    // The leak (fm3000-devmode-auth-message-s1): the login rejects while
    // runtime creation is still running, the vault's cleanup deletes the
    // store dir, and the runaway creation then writes it back - two empty
    // store files with no registry entry, forever.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakes.beforeCreate = () => held;
    const paths = appPathsFor(scratchDir("infinitary-pi-login-"));
    const v = AccountVault.create(paths, {
      pi: new PiAccountBackend({ loginIdleTimeoutMs: 500, loginTimeoutMs: 30 }),
    });
    // The total timeout aborts the sign-in while creation is held open.
    await expect(v.add("openai-codex", "oauth", bridge())).rejects.toThrow(/timed out/i);
    const providerDir = join(paths.accountsDir, "openai-codex");

    // Let the runaway creation finish and write its store files.
    release();
    await vi.waitFor(() => {
      expect(fakes.createFinished.value).toBe(true);
    });
    // The settled sweep removes what the runaway work re-created.
    await vi.waitFor(() => {
      expect(existsSync(providerDir)).toBe(false);
    });
    expect(v.list()).toEqual([]);
  });

  it("rejects when opening the Codex authorize url fails", async () => {
    fakes.login = async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://auth.openai.com/oauth/authorize",
      });
      return new Promise(() => {});
    };
    const capture = bridge();
    capture.openExternal = async () => {
      throw new Error("Could not open the sign-in page.");
    };
    await expect(
      vault(OUT_OF_PLAY_MS, OUT_OF_PLAY_MS).add("openai-codex", "oauth", capture),
    ).rejects.toThrow(/could not open the sign-in page/i);
  });
});

describe("PiAccountBackend health/renew", () => {
  afterEach(() => {
    fakes.login = undefined;
    fakes.beforeCreate = undefined;
    fakes.createFinished.value = false;
    vi.restoreAllMocks();
  });

  it("a signed-in oauth account is healthy; resolve-is-renewal reports renewed", async () => {
    const subject = vault();
    const account = await subject.add("openai-codex", "oauth", bridge());
    const health = await subject.health(account.id);
    expect(health.state).toBe("healthy");
    expect(health.authType).toBe("oauth");
    expect(await subject.renew(account.id, "proactive")).toEqual({ outcome: "renewed" });
  });

  it("a thrown runtime is degraded, never a sign-out", async () => {
    const backend = new PiAccountBackend();
    vi.spyOn(backend, "runtimeFor").mockRejectedValue(new Error("catalog attach failed"));
    const ref = {
      providerId: "openai-codex",
      accountId: "acct_x",
      dir: appPathsFor(scratchDir("infinitary-pi-health-")).accountsDir,
    };
    const health = await backend.health(ref);
    expect(health.state).toBe("degraded");
    expect(health.reason).toBe("unknown");
    expect((await backend.status(ref)).connected).toBe(true);
  });
});
