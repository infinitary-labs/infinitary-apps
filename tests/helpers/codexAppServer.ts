import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { StartCodexProcess } from "../../src/core/codex/appServer";

/**
 * A stand-in for the Codex CLI's app-server (docs/codex-client.md), in
 * memory: it answers the account requests Infinitary sends in the shapes
 * Codex CLI 0.155.1's own protocol bindings name, and its no-account
 * answers are the ones that version gave a scratch home. A real one would
 * spend a saved reset.
 */

/** The ChatGPT account id the stand-in's allowance answer names by default. */
export const STAND_IN_CHATGPT_ID = "5f0d6c1e-chatgpt-account";

export type Sent = { id?: number; method: string; params?: Record<string, unknown> };

export type Behavior = {
  signedIn?: boolean;
  /** The ChatGPT account id Codex's allowance answer names. */
  accountId?: string | null;
  available?: number;
  credits?: { id: string; status: string; expiresAt: number | null }[] | null;
  /** How the consume is answered: an outcome, or `crash` to end the process unanswered. */
  consume?: string | "crash";
  login?: "success" | "failure" | "never";
  /** A kept sign-in that no longer works: Codex says it is signed in and refuses the allowance read until it signs in again. */
  stale?: boolean;
};

/**
 * A stand-in Codex app-server process: records what it is sent, and the
 * Codex home each start was given, and answers in Codex CLI 0.155.1's shapes.
 */
export function standInCodex(behavior: Behavior = {}) {
  const homes: (string | undefined)[] = [];
  const sent: Sent[] = [];
  let starts = 0;
  let signedIn = behavior.signedIn ?? true;
  let available = behavior.available ?? 2;
  let stale = behavior.stale ?? false;
  const start: StartCodexProcess = (_executable, args, env) => {
    starts++;
    if (!args.includes("app-server")) throw new Error(`not the app-server: ${args.join(" ")}`);
    homes.push(env.CODEX_HOME);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exited = false;
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: () => {
        exit();
        return true;
      },
    });
    const exit = () => {
      if (exited) return;
      exited = true;
      Object.assign(child, { exitCode: 0 });
      setImmediate(() => child.emit("close", 0, null));
    };
    const answer = (id: number | undefined, result: unknown) =>
      stdout.write(`${JSON.stringify({ id, result })}\n`);
    const refuse = (id: number | undefined, message: string) =>
      stdout.write(`${JSON.stringify({ id, error: { code: -32600, message } })}\n`);
    let buffer = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at)) as Sent;
        buffer = buffer.slice(at + 1);
        sent.push(message);
        const { id } = message;
        switch (message.method) {
          case "initialize":
            answer(id, { userAgent: "infinitary/0.155.1", platformFamily: "unix" });
            break;
          case "account/read":
            answer(id, {
              account: signedIn ? { type: "chatgpt", email: null, planType: "pro" } : null,
              requiresOpenaiAuth: true,
            });
            break;
          case "account/login/start":
            answer(id, {
              type: "chatgpt",
              loginId: "login-1",
              authUrl:
                "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1",
            });
            if (behavior.login !== "never")
              setImmediate(() => {
                const success = (behavior.login ?? "success") === "success";
                if (success) {
                  signedIn = true;
                  stale = false;
                }
                stdout.write(
                  `${JSON.stringify({
                    method: "account/login/completed",
                    params: {
                      loginId: "login-1",
                      success,
                      error: success ? null : "token exchange failed",
                      onboardingEntrypoint: null,
                    },
                  })}\n`,
                );
              });
            break;
          case "account/rateLimits/read":
            if (!signedIn || stale) {
              refuse(id, "codex account authentication required to read rate limits");
              break;
            }
            answer(id, {
              ordinaryUsageAllowed: false,
              rateLimits: { limitId: "codex", primary: { usedPercent: 100 } },
              rateLimitsByLimitId: null,
              rateLimitResetCredits: {
                availableCount: available,
                credits: behavior.credits === undefined ? null : behavior.credits,
              },
              accountId:
                behavior.accountId === undefined ? STAND_IN_CHATGPT_ID : behavior.accountId,
              rateLimitUpsell: null,
            });
            break;
          case "account/rateLimitResetCredit/consume": {
            if (!signedIn) {
              // Codex CLI 0.155.1's own answer with no account.
              refuse(id, "codex account authentication required for rate limit reset credits");
              break;
            }
            const outcome = behavior.consume ?? "reset";
            if (outcome === "crash") {
              exit();
              break;
            }
            if (outcome === "reset") available = Math.max(0, available - 1);
            answer(id, { outcome });
            break;
          }
          case "account/logout":
            signedIn = false;
            answer(id, {});
            break;
        }
      }
    });
    return child;
  };
  return {
    start,
    sent,
    methods: () => sent.map((message) => message.method),
    starts: () => starts,
    homes,
    set consume(outcome: string) {
      behavior.consume = outcome;
    },
  };
}
