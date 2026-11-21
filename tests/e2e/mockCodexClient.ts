import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @journey-area src/core/codex/
 *
 * A stand-in for the Codex CLI the person installed (docs/codex-client.md),
 * for e2e: a script the app finds through `INFINITARY_CODEX_CLI`, which
 * answers `--version` and runs a stand-in app-server on standard input and
 * output, in the shapes Codex CLI 0.155.1's own protocol bindings name. A
 * real one would spend a saved reset of a real account.
 *
 * Its ChatGPT sign-in listens on a loopback port as Codex's own does, and
 * ends once that address is asked with the sign-in's `state` and any
 * `code`, writing a sign-in file with the account id into its Codex home;
 * nobody is signed in to anything real. Every request it hears is written,
 * one JSON line each, to `requests.jsonl` beside the script.
 */

export type MockCodexOptions = {
  /** What `--version` prints after `codex-cli `. */
  version?: string;
  /** The ChatGPT account id its sign-in and allowance answer name. */
  accountId: string;
  /** How many saved resets it holds. */
  available: number;
  /** Each saved reset's id, status and expiry, in seconds. */
  credits: { id: string; status: string; expiresAt: number | null }[];
};

export type MockCodex = {
  /** The script, for `INFINITARY_CODEX_CLI`. */
  path: string;
  /** Every request the stand-in heard, across its processes, in order. */
  requests: () => { method: string; params?: Record<string, unknown> }[];
};

export function writeMockCodexClient(dir: string, options: MockCodexOptions): MockCodex {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "codex-stub.mjs");
  const log = join(dir, "requests.jsonl");
  const settings = { version: "0.155.1", ...options, log };
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const settings = ${JSON.stringify(settings)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli " + settings.version + "\\n");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(2);
const home = process.env.CODEX_HOME;
if (!home) process.exit(3);
mkdirSync(home, { recursive: true });
const authFile = join(home, "auth.json");
let available = settings.available;
let login;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const answer = (id, result) => send({ id, result });
const refuse = (id, message) => send({ id, error: { code: -32600, message } });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(settings.log, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
  const { id } = message;
  const signedIn = existsSync(authFile);
  switch (message.method) {
    case "initialize":
      return answer(id, { userAgent: "infinitary/" + settings.version, codexHome: home });
    case "initialized":
      return;
    case "account/read":
      return answer(id, {
        account: signedIn ? { type: "chatgpt", email: null, planType: "pro" } : null,
        requiresOpenaiAuth: true,
      });
    case "account/login/start": {
      const loginId = randomUUID();
      const state = randomUUID();
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
          response.writeHead(400).end("Not this sign-in.");
          return;
        }
        writeFileSync(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: settings.accountId } }));
        response.writeHead(200).end("Signed in. You can close this page.");
        server.close();
        send({ method: "account/login/completed", params: { loginId, success: true, error: null, onboardingEntrypoint: null } });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        login = { loginId, server };
        const redirect = "http://localhost:" + port + "/auth/callback";
        answer(id, {
          type: "chatgpt",
          loginId,
          authUrl: "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_stand_in&redirect_uri=" + encodeURIComponent(redirect) + "&state=" + state,
        });
      });
      return;
    }
    case "account/login/cancel":
      login?.server.close();
      return answer(id, { status: "canceled" });
    case "account/rateLimits/read":
      if (!signedIn) return refuse(id, "codex account authentication required to read rate limits");
      return answer(id, {
        ordinaryUsageAllowed: available < settings.available,
        rateLimits: { limitId: "codex", primary: { usedPercent: available < settings.available ? 0 : 100 } },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: { availableCount: available, credits: settings.credits },
        accountId: settings.accountId,
        rateLimitUpsell: null,
      });
    case "account/rateLimitResetCredit/consume":
      if (!signedIn) return refuse(id, "codex account authentication required for rate limit reset credits");
      if (available === 0) return answer(id, { outcome: "noCredit" });
      available -= 1;
      return answer(id, { outcome: "reset" });
    case "account/logout":
      rmSync(authFile, { force: true });
      return answer(id, {});
    default:
      return refuse(id, "unknown method " + message.method);
  }
});
lines.on("close", () => {
  login?.server.close();
  process.exit(0);
});
`,
    { mode: 0o755 },
  );
  return {
    path,
    requests: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
