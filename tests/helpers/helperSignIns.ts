import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { parseInvokeRequest } from "@shared/ipc";
import { servedProviderOf } from "@shared/quota";
import type { DeviceSignInEvent, SignInStep } from "@shared/signIns";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  CLAUDE_HAIKU_CATALOG_VERSION,
  type ClaudeModelRow,
} from "../../src/core/claude/claudeModelCatalog";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { DeviceSignIns } from "../../src/core/devices/deviceSignIns";
import { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import type { GitHubCli } from "../../src/core/forge";
import { startComputerAccounts } from "../../src/core/helper/accounts";
import { startComputerForges } from "../../src/core/helper/forges";
import { joinHome } from "../../src/core/helper/join";
import { type HelperRun, type StartHelperOptions, startHelper } from "../../src/core/helper/run";
import { type HeldSignIns, startSignIns } from "../../src/core/helper/signIns";
import type { HostKeychain, HostKeychainQuery } from "../../src/core/host";
import { configureGitSignIn } from "../../src/core/hostEnv";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import { WorkDevices } from "../../src/core/placed/workDevices";
import type { QuotaHttp } from "../../src/core/quota/http";
import { ModelSlots } from "../../src/core/routing/modelSlots";
import { openInMemoryDatabase } from "../../src/core/storage/db";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { claimedPort } from "./claimedPort";
import type { standInCodex } from "./codexAppServer";
import { scratchDir } from "./scratchDirs";

/**
 * A computer that runs work signs in to its own subscriptions from its home
 * (docs/helper.md, "Its own sign-ins"), end to end on this side: the helper
 * as the work mode composes it, joined through the real pairing, over the
 * real connection, with the real account store and Pi's own sign-in flows.
 * The home is its real `DeviceSignIns` over the connection's own reach. The
 * providers are stand-ins: Pi's requests to Grok's and Codex's sign-in
 * endpoints, GitHub's device flow and the allowance's, are answered here, and
 * Claude's client is a script that prints what the real one does, so nothing
 * reaches the network and nobody is signed in to anything real.
 */

const BUILDER = { name: "builder", uid: 502 };
/** What the captain types, which the home must keep nowhere. */
export const KEY = "sk-or-v1-standin-typed-key-0042";
export const PASTED_CODE = "standin-pasted-code-0042";
/** The code Claude's page shows, which the captain pastes back at home. */
export const CLAUDE_CODE = "standin-claude-code#state-0042";
/** The link Claude Code prints with no terminal: its page shows a code to copy. */
export const CLAUDE_CODE_PAGE =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s0042";
/** What GitHub hands the computer for an approved code: its own sign-in, never the home's. */
export const GITHUB_SIGN_IN = "gho_standin_computer_0042";

/** A key the captain made on their GitHub Enterprise server and typed at home, for the computer. */
export const ENTERPRISE_KEY = "ghp_standin_enterprise_0042";

/** What GitLab on the person's own server hands the computer for an approved browser code. */
export const GITLAB_SIGN_IN = "standin-gitlab-access-0042";

/** An API token the captain made on their Atlassian account for Bitbucket and typed at home, for the computer. */
export const BITBUCKET_KEY = "ATATT3xFfGF0standin_bitbucket-0042=0A1B2C3D";

/** A public application the person registered on their GitLab server; never a secret. */
export const GITLAB_APPLICATION = "standin0application0id0042";

/**
 * A GitHub Enterprise server and a GitLab server of the person's own, as the
 * computer asks them: GitHub Enterprise's "who is this" answers only the
 * key made there; GitLab's browser code is pending once, then hands the
 * computer its own sign-in, which its "who is this" answers.
 */
export function standInServers() {
  const asked: { url: string; auth?: string }[] = [];
  let pending = 1;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    asked.push({ url, ...(auth ? { auth } : {}) });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://github.example.com/api/v3/user")
      return auth === `Bearer ${ENTERPRISE_KEY}` || auth === `token ${ENTERPRISE_KEY}`
        ? json(200, { login: "mona" })
        : json(401, { message: "Bad credentials" });
    if (url === "https://api.bitbucket.org/2.0/user")
      return auth === `Bearer ${BITBUCKET_KEY}`
        ? json(200, { type: "user", display_name: "Octo Cat", nickname: "octo" })
        : json(401, { type: "error", error: { message: "Unauthorized" } });
    if (url === "https://gitlab.example.com/oauth/authorize_device")
      return json(200, {
        device_code: "standin-gitlab-device",
        user_code: "GLAB-0042",
        verification_uri: "https://gitlab.example.com/oauth/device",
        expires_in: 900,
        interval: 1,
      });
    if (url === "https://gitlab.example.com/oauth/token")
      return pending-- > 0
        ? json(400, { error: "authorization_pending" })
        : json(200, {
            access_token: GITLAB_SIGN_IN,
            token_type: "Bearer",
            expires_in: 7200,
            scope: "api write_repository",
          });
    if (url === "https://gitlab.example.com/api/v4/user")
      return auth === `Bearer ${GITLAB_SIGN_IN}`
        ? json(200, { username: "tanuki" })
        : json(401, { message: "401 Unauthorized" });
    return json(404, {});
  });
  return { asked };
}

/** What GitHub CLI there prints for github.com: its own sign-in, never one the app made. */
export const GITHUB_CLI_SIGN_IN = "gho_standin_githubcli_0042";

/** An unsigned token whose claims Pi and the allowance read the account from. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
export const CODEX_ACCESS = token({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-standin" },
});

/**
 * What a current Claude Code there answers for its model picker
 * (claudeModelCatalog.test.ts): the computer reads its own client's list,
 * as the home reads its own, and never this Mac's client.
 */
export const CLAUDE_CLIENT_ROWS: ClaudeModelRow[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
];

/** Grok's and Codex's sign-in endpoints as Pi asks them, answered here. */
export function standInProviders() {
  const asked: { url: string; body: string }[] = [];
  let grokPending = 1;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body ? String(init.body) : "";
    asked.push({ url, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://auth.x.ai/oauth2/device/code")
      return json(200, {
        device_code: "standin-device",
        user_code: "WXYZ-4242",
        verification_uri: "https://accounts.x.ai/device",
        expires_in: 600,
        interval: 1,
      });
    if (url === "https://auth.x.ai/oauth2/token") {
      if (grokPending-- > 0) return json(400, { error: "authorization_pending" });
      return json(200, {
        access_token: "standin-grok",
        refresh_token: "standin-grok-r",
        expires_in: 3600,
      });
    }
    if (url === "https://auth.openai.com/oauth/token")
      return json(200, {
        access_token: CODEX_ACCESS,
        refresh_token: "standin-codex-r",
        expires_in: 3600,
      });
    return json(404, {});
  });
  return asked;
}

/**
 * GitHub's device flow and its "who is this", as the computer asks them,
 * answered here: one pending answer, then the computer's own sign-in. The
 * test may make GitHub refuse it, as GitHub does once it no longer accepts one.
 */
export function standInGitHub(options: { hold?: boolean } = {}) {
  let hold = options.hold === true;
  const asked: { url: string; auth?: string }[] = [];
  let pending = 1;
  let refuse = false;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    asked.push({ url, ...(auth ? { auth } : {}) });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://github.com/login/device/code")
      return json(200, {
        device_code: "standin-github-device",
        user_code: "WDJB-0042",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      });
    if (url === "https://github.com/login/oauth/access_token")
      return hold || pending-- > 0
        ? json(200, { error: "authorization_pending" })
        : json(200, { access_token: GITHUB_SIGN_IN, token_type: "bearer", scope: "repo,workflow" });
    if (url === "https://api.github.com/user")
      return refuse ? json(401, { message: "Bad credentials" }) : json(200, { login: "octo-mini" });
    return json(404, {});
  });
  return {
    asked,
    approve: () => {
      hold = false;
      pending = 0;
    },
    refuse: () => {
      refuse = true;
    },
  };
}

/** The access in the Claude login Claude Code keeps on the computer, never one of the home's. */
export const CLAUDE_ACCESS = "standin-claude-access-0042";

/**
 * The computer's saved passwords, where Claude Code keeps its login: it
 * answers a read macOS would not ask about with that login, and refuses, as
 * macOS does, one it would have to ask about. It writes down every query, so
 * a test can see that nothing was asked with a dialog allowed.
 */
export function standInSavedPasswords(options: { allows: boolean }) {
  const queries: HostKeychainQuery[] = [];
  const login = JSON.stringify({
    claudeAiOauth: {
      accessToken: CLAUDE_ACCESS,
      expiresAt: Date.now() + 3_600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
    },
  });
  const keychain: HostKeychain = {
    findGenericPassword: async (query) => {
      queries.push(query);
      return { kind: "found", modifiedAt: "20261004120000Z", locked: false };
    },
    readGenericPassword: async (query) => {
      queries.push(query);
      return options.allows
        ? { kind: "value", value: login }
        : // errSecInteractionNotAllowed: macOS would have had to ask.
          { kind: "failed", code: -25308, message: "User interaction is not allowed." };
    },
  };
  return {
    keychain,
    queries,
    allow: () => {
      options.allows = true;
    },
  };
}

/** The allowance's requests, answered here: a Codex reading for the computer's own account. */
function standInAllowance(codexModels?: readonly string[]): {
  http: QuotaHttp;
  asked: { url: string; auth?: string }[];
  /** What Codex's usage says from the next read on: how much is used, and its credits. */
  codex: { usedPercent: number; credits?: Record<string, unknown> };
} {
  const asked: { url: string; auth?: string }[] = [];
  const codex: { usedPercent: number; credits?: Record<string, unknown> } = { usedPercent: 12 };
  return {
    asked,
    codex,
    http: async (url, init) => {
      asked.push({
        url,
        ...(init.headers?.Authorization ? { auth: init.headers.Authorization } : {}),
      });
      if (codexModels && new URL(url).pathname === "/backend-api/codex/models")
        return { status: 200, json: { models: codexModels.map((slug) => ({ slug })) } };
      if (url === "https://chatgpt.com/backend-api/wham/usage")
        return {
          status: 200,
          json: {
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: codex.usedPercent,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3_600,
              },
            },
            ...(codex.credits ? { credits: codex.credits } : {}),
          },
        };
      // Claude's, for the computer's own login alone.
      if (url === "https://api.anthropic.com/api/oauth/usage")
        return init.headers?.Authorization === `Bearer ${CLAUDE_ACCESS}`
          ? {
              status: 200,
              json: {
                five_hour: {
                  utilization: 27,
                  resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
                },
              },
            }
          : { status: 401 };
      return { status: 404 };
    },
  };
}

export function savedText(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return savedText(path);
    if (!entry.isFile()) return [];
    return [{ file: path, text: readFileSync(path, "latin1") }];
  });
}

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const runs: HelperRun[] = [];
const homes: DeviceSignIns[] = [];

beforeEach(() => {
  // Codex's own callback page would listen on this Mac; a pasted code is the path under test.
  vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "203.0.113.1");
  vi.stubEnv("PI_OFFLINE", "1");
  // GitHub at its own address, which the stand-in answers.
  vi.stubEnv("INFINITARY_GITHUB_OAUTH_URL", "");
  vi.stubEnv("INFINITARY_GITHUB_API_URL", "");
});

afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  for (const home of homes.splice(0)) home.dispose();
  // A catalog refresh writes its store when it lands; the folder is removed after.
  await catalogRefreshesSettled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  configureGitSignIn(undefined);
});

/**
 * A home with its real sign-ins over the connection, and a computer joined to
 * it as another user. Given the computer's saved passwords, Claude's store
 * there is read as in production - its file and those saved passwords -
 * rather than said by the test.
 */
export async function joined(
  options: {
    claudeLogin?: "live" | "absent";
    gitAskpass?: string;
    keychain?: HostKeychain;
    /** What Claude's client there answers for its model list; a current client's by default. */
    claudeModels?: ClaudeModelRow[] | "no answer";
    /** What the Codex account's own model list answers there; unread unless named. */
    codexModels?: readonly string[];
    /** GitHub CLI installed there; none by default, so no test finds the real one. */
    githubCli?: GitHubCli;
    /** Observe real sockets to exercise HomeLink's quick-redial grace. */
    dial?: StartHelperOptions["dial"];
    /** Computer-originated steps, before the real connection sends them home. */
    onStep?: (signInId: string, step: SignInStep) => void;
    /** The Codex CLI there; none by default, so no test starts the real one. */
    codex?: ReturnType<typeof standInCodex>;
  } = {},
) {
  const homeDir = scratchDir("infinitary-signins-home-");
  // The home's slot record and pins, which its rail protects, as the app keeps them.
  const settings = new SettingsStore(openInMemoryDatabase());
  const slots = new ModelSlots({
    settings,
    accounts: () => [],
    quotaModels: () => undefined,
    kept: () =>
      settings
        .getRoutingSettings()
        .pins.map((pin) => ({ provider: servedProviderOf(pin.provider), id: pin.id })),
  });
  const pairing = new DevicePairing({
    dir: join(homeDir, "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ownUid: 501,
  });
  pairings.push(pairing);
  const pushes: DeviceSignInEvent[] = [];
  const emitted: unknown[] = [];
  const events: FmEvent[] = [];
  const work = new WorkDevices();
  const signIns = new DeviceSignIns({
    devices: () => pairing.list(),
    work,
    emit: (channel, payload) => {
      emitted.push(payload);
      if (channel === "inf:devices:sign-in") pushes.push(payload as DeviceSignInEvent);
    },
    broadcastEvent: (event) => events.push(event),
    protectedIds: (providerId) => slots.protectedIds(providerId),
  });
  homes.push(signIns);
  // The home's core as far as a computer's sign-ins reach it.
  const dispatch = (async (channel, rawArgs, actor) => {
    if (actor?.kind !== "device") throw new Error(`Rejected ${channel}`);
    const [request] = parseInvokeRequest(channel, rawArgs) as [never];
    if (channel === "inf:work:sign-in") return signIns.step(actor.deviceId, request);
    if (channel === "inf:work:sign-ins") return signIns.changed(actor.deviceId, request);
    throw new Error(`Rejected ${channel}`);
  }) as CoreDispatch;
  const port = await claimedPort();
  const connection = startConnection({
    dispatch,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
  });
  connections.push(connection);
  work.attach(connection);
  const { link } = pairing.invite({ kind: "work", at: `127.0.0.1:${port}` });
  await connection.settled();

  const dataDir = scratchDir("infinitary-signins-computer-");
  const done = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 2_000,
  });
  if (!done.ok) throw new Error(done.reason);
  const deviceId = done.grant.deviceId;
  const allowance = standInAllowance(options.codexModels);
  const claudeDir = scratchDir("infinitary-signins-claude-");
  // Who the login there is, where Claude Code keeps it beside the login.
  writeFileSync(
    join(claudeDir, ".config.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "builder@example.com" } }),
  );
  // Claude's client there, as a script: what it printed, what it was pasted, and its login.
  const claude = {
    loggedIn: options.claudeLogin === "live",
    browser: [] as unknown[],
    pasted: [] as unknown[],
    logouts: 0,
    /** How many times something asked it for its model list. */
    listReads: 0,
    allowanceReads: [] as string[],
  };
  let held: Promise<HeldSignIns> | undefined;
  const logs: string[] = [];
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [20],
    ...(options.dial ? { dial: options.dial } : {}),
    log: (line) => logs.push(line),
    ...(options.gitAskpass ? { gitAskpass: options.gitAskpass } : {}),
    ...(options.keychain ? { keychain: options.keychain } : {}),
    signIns: (start) => {
      held = startSignIns({
        ...start,
        codex: options.codex
          ? {
              check: async () => ({
                state: "ready",
                executable: "/usr/local/bin/codex",
                version: "0.155.1",
              }),
              start: options.codex.start,
            }
          : { check: async () => ({ state: "missing" }) },
        tell: (channel, args) => {
          if (channel === "inf:work:sign-in") {
            const [request] = parseInvokeRequest(channel, args);
            options.onStep?.(request.signInId, request.step);
          }
          return start.tell(channel, args);
        },
        forges: (forgeOptions) =>
          startComputerForges({
            ...forgeOptions,
            cli: options.githubCli ?? {
              find: () => undefined,
              token: async () => ({ problem: "missing", reason: "GitHub CLI is not installed" }),
            },
          }),
        accounts: async (accountsOptions) => {
          const accounts = await startComputerAccounts({
            ...accountsOptions,
            http: allowance.http,
            clock: false,
            claudeList: {
              read: async () => {
                claude.listReads += 1;
                // The client's own words when its list does not come back.
                if (options.claudeModels === "no answer")
                  throw new Error("Claude did not list its models in time.");
                return options.claudeModels ?? CLAUDE_CLIENT_ROWS;
              },
              clientVersion: async () => CLAUDE_HAIKU_CATALOG_VERSION,
            },
            claude: {
              available: () => true,
              configDir: () => claudeDir,
              run: async (args, _dir, run) => {
                if (args[0] === "auth" && args[1] === "login") {
                  // What Claude Code 2.1.288 prints with no terminal, then the code it waits for.
                  claude.browser.push(run?.env?.BROWSER);
                  run?.onStdout?.(
                    "Opening browser to sign in…\nIf the browser didn't open, visit: ",
                  );
                  run?.onStdout?.(`${CLAUDE_CODE_PAGE}\nPaste code here if prompted > `);
                  const code = await run?.paste;
                  claude.pasted.push(code);
                  claude.loggedIn = code === CLAUDE_CODE;
                  return claude.loggedIn
                    ? { code: 0, stdout: "Login successful.", stderr: "" }
                    : { code: 1, stdout: "", stderr: "Login failed: Invalid authorization code" };
                }
                if (args[0] === "auth" && args[1] === "logout") {
                  claude.logouts += 1;
                  claude.loggedIn = false;
                  return { code: 0, stdout: "", stderr: "" };
                }
                return {
                  code: claude.loggedIn ? 0 : 1,
                  stdout: JSON.stringify({ loggedIn: claude.loggedIn }),
                  stderr: "",
                };
              },
              ...(options.keychain
                ? {}
                : {
                    readStore: async () =>
                      claude.loggedIn
                        ? {
                            state: "present",
                            auth: { accessToken: "standin-token" },
                            identity: { accountUuid: "standin-account" },
                          }
                        : { state: "absent" },
                  }),
            },
          });
          const readAllowance = accounts.readAllowance;
          return {
            ...accounts,
            readAllowance: async (reason) => {
              const result = await readAllowance(reason);
              claude.allowanceReads.push(reason);
              return result;
            },
          };
        },
      });
      return held;
    },
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  // The helper's own connection, not the one joining dialed once to hear the home's name.
  await expect.poll(() => started.run.state().contact).toBe("in-reach");
  await expect.poll(() => work.inReach(deviceId)).toBe(true);

  const steps = (signInId: string): SignInStep[] =>
    pushes.filter((event) => event.signInId === signInId).map((event) => event.step);
  const ended = async (signInId: string) => {
    // A device code is polled once a second, as the provider asks.
    await expect
      .poll(() => steps(signInId).some((step) => step.kind === "ended"), { timeout: 4_000 })
      .toBe(true);
    return steps(signInId).find((step) => step.kind === "ended");
  };
  const prompt = async (signInId: string) => {
    await expect.poll(() => steps(signInId).some((step) => step.kind === "prompt")).toBe(true);
    const step = steps(signInId).findLast((entry) => entry.kind === "prompt");
    if (step?.kind !== "prompt") throw new Error("no prompt");
    return step.prompt;
  };
  const group = () => signIns.view().find((device) => device.deviceId === deviceId);
  return {
    homeDir,
    dataDir,
    deviceId,
    settings,
    logs,
    claudeDir,
    signIns,
    connection,
    work,
    emitted,
    events,
    allowance,
    claude,
    steps,
    signInIds: () => [...new Set(pushes.map((event) => event.signInId))],
    ended,
    prompt,
    group,
    held: () => {
      if (!held) throw new Error("The computer's sign-ins never loaded.");
      return held;
    },
    state: started.run.state,
    stop: () => started.run.stop(),
  };
}

/** Signs the computer in to Codex, the address its browser ends on pasted back at home. */
export async function signInToCodex(world: Awaited<ReturnType<typeof joined>>): Promise<void> {
  const { signInId } = await world.signIns.start(world.deviceId, "openai-codex", "oauth");
  const method = await world.prompt(signInId);
  await world.signIns.answer(signInId, method.promptId, "browser");
  await expect
    .poll(() => world.steps(signInId).some((step) => step.kind === "notice" && step.notice.url))
    .toBe(true);
  const link = world
    .steps(signInId)
    .flatMap((step) => (step.kind === "notice" && step.notice.url ? [step.notice.url] : []))[0];
  const opened = new URL(link ?? "");
  const endsOn = new URL(opened.searchParams.get("redirect_uri") ?? "");
  endsOn.search = new URLSearchParams({
    code: PASTED_CODE,
    scope: "openid profile email offline_access",
    state: opened.searchParams.get("state") ?? "",
  }).toString();
  const paste = await world.prompt(signInId);
  await world.signIns.answer(signInId, paste.promptId, endsOn.toString());
  expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
}

/** The model ids of one provider the home last heard that computer's account of it serve. */
export function servedThere(world: Awaited<ReturnType<typeof joined>>, providerId: string) {
  const signIns = world.group()?.signIns;
  const account = signIns?.accounts.find((row) => row.providerId === providerId);
  return signIns?.served
    ?.find((row) => row.accountId === account?.id)
    ?.models.filter((model) => model.provider === providerId)
    .map((model) => model.id)
    .sort();
}
