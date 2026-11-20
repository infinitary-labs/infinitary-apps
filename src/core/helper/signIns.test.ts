import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FmEvent } from "@shared/events";
import { BITBUCKET, GITHUB_ENTERPRISE, GITLAB } from "@shared/forges";
import { parseInvokeRequest } from "@shared/ipc";
import { STARTER_SLOTS } from "@shared/modelSlots";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { KEYCHAIN_VALUE_FAILURE_THERE, servedProviderOf } from "@shared/quota";
import { type DeviceSignInEvent, returnsToLoopback, type SignInStep } from "@shared/signIns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { NO_BROWSER } from "../claude/claudeCli";
import {
  CLAUDE_HAIKU_CATALOG_VERSION,
  type ClaudeModelRow,
  claudeServedModels,
} from "../claude/claudeModelCatalog";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import { acquireSessionLease } from "../claude/claudeStoreLease";
import { type HomeConnection, startConnection } from "../connection/connection";
import { DeviceSignIns } from "../devices/deviceSignIns";
import { dialHome } from "../devices/dial";
import { DevicePairing } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { ForgeSignInStore, type GitHubCli } from "../forge";
import { absentKeychain, type HostKeychain, type HostKeychainQuery } from "../host";
import { configureGitSignIn, hostEnv } from "../hostEnv";
import { CODEX_MODELS_URL } from "../models/piAccountLists";
import { catalogRefreshesSettled } from "../pi/modelRuntime";
import { WorkDevices } from "../placed/workDevices";
import type { QuotaHttp } from "../quota/http";
import { actualComputerPool } from "../routing/computerPool";
import { ModelSlots } from "../routing/modelSlots";
import { route } from "../routing/routingEngine";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { startComputerAccounts } from "./accounts";
import { bindHere, noSignInHere } from "./conversations";
import { startComputerForges } from "./forges";
import { joinHome } from "./join";
import { type HelperRun, type StartHelperOptions, startHelper } from "./run";
import { type HeldSignIns, startSignIns } from "./signIns";

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
const KEY = "sk-or-v1-standin-typed-key-0042";
const PASTED_CODE = "standin-pasted-code-0042";
/** The code Claude's page shows, which the captain pastes back at home. */
const CLAUDE_CODE = "standin-claude-code#state-0042";
/** The link Claude Code prints with no terminal: its page shows a code to copy. */
const CLAUDE_CODE_PAGE =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s0042";
/** What GitHub hands the computer for an approved code: its own sign-in, never the home's. */
const GITHUB_SIGN_IN = "gho_standin_computer_0042";

/** A key the captain made on their GitHub Enterprise server and typed at home, for the computer. */
const ENTERPRISE_KEY = "ghp_standin_enterprise_0042";

/** What GitLab on the person's own server hands the computer for an approved browser code. */
const GITLAB_SIGN_IN = "standin-gitlab-access-0042";

/** An API token the captain made on their Atlassian account for Bitbucket and typed at home, for the computer. */
const BITBUCKET_KEY = "ATATT3xFfGF0standin_bitbucket-0042=0A1B2C3D";

/** A public application the person registered on their GitLab server; never a secret. */
const GITLAB_APPLICATION = "standin0application0id0042";

/**
 * A GitHub Enterprise server and a GitLab server of the person's own, as the
 * computer asks them: GitHub Enterprise's "who is this" answers only the
 * key made there; GitLab's browser code is pending once, then hands the
 * computer its own sign-in, which its "who is this" answers.
 */
function standInServers() {
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
const GITHUB_CLI_SIGN_IN = "gho_standin_githubcli_0042";

/** An unsigned token whose claims Pi and the allowance read the account from. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const CODEX_ACCESS = token({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-standin" },
});

/**
 * What a current Claude Code there answers for its model picker
 * (claudeModelCatalog.test.ts): the computer reads its own client's list,
 * as the home reads its own, and never this Mac's client.
 */
const CLAUDE_CLIENT_ROWS: ClaudeModelRow[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
];

/** Grok's and Codex's sign-in endpoints as Pi asks them, answered here. */
function standInProviders() {
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
function standInGitHub(options: { hold?: boolean } = {}) {
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
const CLAUDE_ACCESS = "standin-claude-access-0042";

/**
 * The computer's saved passwords, where Claude Code keeps its login: it
 * answers a read macOS would not ask about with that login, and refuses, as
 * macOS does, one it would have to ask about. It writes down every query, so
 * a test can see that nothing was asked with a dialog allowed.
 */
function standInSavedPasswords(options: { allows: boolean }) {
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
      // The Codex account's own model list, in Codex's shape, when the test names one.
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

/** Every file under `dir`, as text, for a search. */
function savedText(dir: string): { file: string; text: string }[] {
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
async function joined(
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
  // What the computer wrote to its own log.
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

  /** Every step of one sign-in the home heard, in order. */
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
async function signInToCodex(world: Awaited<ReturnType<typeof joined>>): Promise<void> {
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
function servedThere(world: Awaited<ReturnType<typeof joined>>, providerId: string) {
  const signIns = world.group()?.signIns;
  const account = signIns?.accounts.find((row) => row.providerId === providerId);
  return signIns?.served
    ?.find((row) => row.accountId === account?.id)
    ?.models.filter((model) => model.provider === providerId)
    .map((model) => model.id)
    .sort();
}

describe("a computer that runs work signs in to its own subscriptions from its home", () => {
  it("lists what it can sign in to only once its home asks, with no sign-in yet", async () => {
    const world = await joined();
    // Nothing of the sign-ins loads until the home asks about them.
    expect(world.group()).toMatchObject({ name: "Mac mini", user: "builder", signIns: null });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.providers.map((p) => p.id))
      .toEqual(expect.arrayContaining(["openai-codex", "xai", "openrouter", "anthropic-claude"]));
    expect(world.group()?.signIns?.accounts).toEqual([]);
    expect(world.group()?.reach).toBe("in-reach");
  });

  it("signs in to OpenRouter with a key typed at home, which the home keeps nowhere", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    const asked = await world.prompt(signInId);
    expect(asked.kind).toBe("secret");
    await world.signIns.answer(signInId, asked.promptId, KEY);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });

    // Its row is in its own group at home, and the feed says it.
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["openrouter"]);
    expect(world.events).toContainEqual(
      expect.objectContaining({
        type: "device_signed_in",
        who: "Builder",
        provider: "OpenRouter",
      }),
    );
    // The key is in the computer's own store, private to it.
    const store = savedText(join(world.dataDir, "accounts")).filter(({ text }) =>
      text.includes(KEY),
    );
    expect(store.map(({ file }) => file)).toEqual([expect.stringMatching(/auth\.json$/)]);
    expect(statSync(store[0]?.file ?? "").mode & 0o777).toBe(0o600);
    // Nothing the home said, pushed or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(KEY);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(KEY))).toEqual([]);
  });

  it("signs in to Grok with a code read at home, which the computer finishes itself", async () => {
    const asked = standInProviders();
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "xai", "oauth");
    await expect
      .poll(() =>
        world.steps(signInId).find((step) => step.kind === "notice" && step.notice.userCode),
      )
      .toMatchObject({
        notice: { kind: "device_code", userCode: "WXYZ-4242", url: "https://accounts.x.ai/device" },
      });
    // Nobody types anything: the computer polls until the provider says yes.
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    expect(asked.filter(({ url }) => url === "https://auth.x.ai/oauth2/token").length).toBe(2);
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["xai"]);
  });

  it("signs in to Codex with the address the browser ends on pasted back at home, and reads its allowance there", async () => {
    const asked = standInProviders();
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openai-codex", "oauth");
    const method = await world.prompt(signInId);
    expect(method.kind).toBe("select");
    await world.signIns.answer(signInId, method.promptId, "browser");
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: { kind: "auth_url", url: expect.stringMatching(/^https:\/\/auth\.openai\.com\//) },
      });
    // Its link sends the browser back to the Mac it opens on, where this
    // computer's sign-in does not wait: the captain pastes that address.
    const link = world
      .steps(signInId)
      .flatMap((step) => (step.kind === "notice" && step.notice.url ? [step.notice.url] : []))[0];
    expect(returnsToLoopback(link)).toBe(true);
    const opened = new URL(link ?? "");
    const endsOn = new URL(opened.searchParams.get("redirect_uri") ?? "");
    endsOn.search = new URLSearchParams({
      code: PASTED_CODE,
      scope: "openid profile email offline_access",
      state: opened.searchParams.get("state") ?? "",
    }).toString();
    const paste = await world.prompt(signInId);
    expect(paste.kind).toBe("manual_code");
    await world.signIns.answer(signInId, paste.promptId, endsOn.toString());
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The code inside that address is the one exchanged there.
    expect(
      asked
        .filter(({ url }) => url === "https://auth.openai.com/oauth/token")
        .map(({ body }) => new URLSearchParams(body).get("code")),
    ).toEqual([PASTED_CODE]);

    // The allowance is read on the computer, with its own sign-in, and shown at home.
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    await expect
      .poll(() =>
        world.group()?.signIns?.quota?.providers.find((row) => row.accountId === account.id),
      )
      .toMatchObject({
        status: "ok",
        windows: [expect.objectContaining({ percentRemaining: 88 })],
      });
    expect(world.allowance.asked).toContainEqual({
      url: "https://chatgpt.com/backend-api/wham/usage",
      auth: `Bearer ${CODEX_ACCESS}`,
    });
    expect(JSON.stringify([world.emitted, world.events])).not.toContain(PASTED_CODE);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(PASTED_CODE))).toEqual([]);

    // A placed conversation binds to that account, and to no other.
    const { accounts } = await world.held();
    const binding = await bindHere(
      { backend: "pi", provider: "openai-codex", accountId: "acct_from_home" },
      accounts,
    );
    expect(binding).toMatchObject({ backend: "pi", accountId: account.id });
    await expect(bindHere({ backend: "pi", provider: "xai" }, accounts)).rejects.toThrow(
      noSignInHere("xai"),
    );
  });

  // INF-4275: a computer's own account keeps going on credits, set from its home.
  it("keeps a computer's own Codex account going on credits from home, saved there, so its spent allowance routes on credits", async () => {
    standInProviders();
    const world = await joined();
    // Its allowance is used up, and ChatGPT says the account has credits.
    world.allowance.codex.usedPercent = 100;
    world.allowance.codex.credits = { has_credits: true, balance: "12.50" };
    await signInToCodex(world);
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    const row = () =>
      world.group()?.signIns?.quota?.providers.find((entry) => entry.accountId === account.id);
    await expect.poll(() => row()?.credits?.state).toBe("available");
    const onCredits = () => {
      const signIns = world.group()?.signIns ?? null;
      const models = (signIns?.served ?? []).flatMap((served) =>
        served.models.map((model) => ({ ...model, name: model.name ?? model.id })),
      );
      return actualComputerPool("Mac mini", signIns, models, Date.now())?.catalog.some(
        (model) => model.onCredits === true,
      );
    };
    // A computer on this build takes the switch; with it off, nothing serves on credits.
    expect(world.group()?.keepGoing).toBe(true);
    expect(onCredits()).toBe(false);
    // Codex refused a turn there: the spent allowance is held until its reset.
    const { accounts } = await world.held();
    accounts.vault.noteCutOff(account.id, {
      class: "no_headroom",
      resetsAt: Date.now() + 3_600_000,
    });

    await world.signIns.keepGoing(world.deviceId, account.id, true);
    // Its credits answer, so the switch ends that hold there at once.
    expect(accounts.vault.cutOff(account.id)).toBeUndefined();
    expect(world.group()?.signIns?.accounts.find((entry) => entry.id === account.id)).toMatchObject(
      { keepGoingOnCredits: true },
    );
    expect(row()?.keepGoingOnCredits).toBe(true);
    expect(onCredits()).toBe(true);
    // Saved on the computer's own account, and nowhere at home.
    expect(
      savedText(world.dataDir).some(({ text }) => text.includes('"keepGoingOnCredits": true')),
    ).toBe(true);
    expect(
      savedText(world.homeDir).filter(({ text }) => text.includes("keepGoingOnCredits")),
    ).toEqual([]);

    await world.signIns.keepGoing(world.deviceId, account.id, false);
    expect(row()?.keepGoingOnCredits).toBeUndefined();
    expect(onCredits()).toBe(false);
    await expect(world.signIns.keepGoing(world.deviceId, "acct_elsewhere", true)).rejects.toThrow(
      "Builder has no account with that id.",
    );
  });

  // INF-4280's audit, fix 1: a computer's own account is renamed, paused and preferred from its home.
  it("renames, pauses and prefers a computer's own Codex account from home, saved only there, so its routing there follows", async () => {
    standInProviders();
    const world = await joined();
    await signInToCodex(world);
    const account = await vi.waitFor(() => {
      const found = world
        .group()
        ?.signIns?.accounts.find((row) => row.providerId === "openai-codex");
      if (!found) throw new Error("not yet");
      return found;
    });
    const seen = () => world.group()?.signIns?.accounts.find((row) => row.id === account.id);
    const pooled = () => {
      const signIns = world.group()?.signIns ?? null;
      const models = (signIns?.served ?? []).flatMap((served) =>
        served.models.map((model) => ({ ...model, name: model.name ?? model.id })),
      );
      return actualComputerPool("Mac mini", signIns, models, Date.now())?.catalog.length ?? 0;
    };
    await expect.poll(pooled).toBeGreaterThan(0);
    expect(world.group()?.accountSettings).toBe(true);

    await world.signIns.setAccount(world.deviceId, {
      kind: "rename",
      accountId: account.id,
      label: "Studio Codex",
    });
    expect(seen()?.label).toBe("Studio Codex");
    await world.signIns.setAccount(world.deviceId, {
      kind: "pin",
      providerId: "openai-codex",
      accountId: account.id,
    });
    expect(seen()?.pinned).toBe(true);
    // Paused there, its models leave that computer's routing; its sign-in stays.
    await world.signIns.setAccount(world.deviceId, {
      kind: "set-enabled",
      accountId: account.id,
      enabled: false,
    });
    expect(seen()).toMatchObject({ enabled: false, connected: true });
    expect(pooled()).toBe(0);
    // Saved in the computer's own store, and nowhere at home.
    expect(savedText(world.dataDir).some(({ text }) => text.includes("Studio Codex"))).toBe(true);
    expect(savedText(world.homeDir).filter(({ text }) => text.includes("Studio Codex"))).toEqual(
      [],
    );

    await world.signIns.setAccount(world.deviceId, {
      kind: "set-enabled",
      accountId: account.id,
      enabled: true,
    });
    await expect.poll(pooled).toBeGreaterThan(0);
    await expect(
      world.signIns.setAccount(world.deviceId, {
        kind: "set-enabled",
        accountId: "acct_elsewhere",
        enabled: false,
      }),
    ).rejects.toThrow("Builder has no account with that id.");
  });

  // INF-4280's audit, fix 3: Refresh asks each computer to read its allowance now, not at its next tick.
  it("has a computer read its own allowance now when the home refreshes", async () => {
    standInProviders();
    const world = await joined();
    await signInToCodex(world);
    const left = () =>
      world.group()?.signIns?.quota?.providers.find((row) => row.provider === "codex")?.windows[0]
        ?.percentRemaining;
    await expect.poll(left).toBe(100 - world.allowance.codex.usedPercent);
    const usage = () =>
      world.allowance.asked.filter((ask) => ask.url.endsWith("/wham/usage")).length;
    const before = usage();
    world.allowance.codex.usedPercent = 64;

    await world.signIns.readAllowance();
    expect(usage()).toBe(before + 1);
    expect(left()).toBe(36);
  });

  it("signs a computer out of one of its own accounts from home", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, KEY);
    await world.ended(signInId);
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });
    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(savedText(world.dataDir).filter(({ text }) => text.includes(KEY))).toEqual([]);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "OpenRouter",
    });
  });

  it("signs the computer out of the Claude login Firstmate made there when the home signs it out of Claude", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, CLAUDE_CODE);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(world.claude.logouts).toBe(1);
    expect(world.claude.loggedIn).toBe(false);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "Claude",
      login: "signed-out",
    });
  });

  it("leaves the Claude login that was there before when the home signs the computer out of Claude", async () => {
    const world = await joined({ claudeLogin: "live" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    await world.signIns.signOut(world.deviceId, account.id);
    await expect.poll(() => world.group()?.signIns?.accounts).toEqual([]);
    expect(world.claude.logouts).toBe(0);
    expect(world.claude.loggedIn).toBe(true);
    expect(world.events).toContainEqual({
      type: "device_signed_out",
      deviceId: world.deviceId,
      who: "Builder",
      provider: "Claude",
      login: "kept",
    });
  });

  it("adopts the Claude login already there, and asks for nothing", async () => {
    const live = await joined({ claudeLogin: "live" });
    const adopted = await live.signIns.start(live.deviceId, "anthropic-claude", "oauth");
    expect(await live.ended(adopted.signInId)).toMatchObject({ outcome: "signed-in" });
    expect(live.steps(adopted.signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(live.claude.browser).toEqual([]);
  });

  it("offers an Automatic start there the Claude models it serves once signed in to Claude", async () => {
    const world = await joined({ claudeLogin: "live" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The home's catalog lists Claude's models whether or not anything there serves them.
    const catalog = CLAUDE_MODELS.map((model) => ({ provider: CLAUDE_PROVIDER_ID, ...model }));
    const pool = () =>
      actualComputerPool("Mac mini", world.group()?.signIns ?? null, catalog, Date.now());
    await expect.poll(() => pool()?.available.length ?? 0).toBeGreaterThan(0);
    const chosen = pool();
    const { choice } = route({
      catalog: chosen?.catalog ?? [],
      available: chosen?.available ?? [],
      pins: [],
      bucket: "medium",
    });
    expect(choice?.provider).toBe(CLAUDE_PROVIDER_ID);
    // It runs there on that computer's own Claude account.
    const account = world
      .group()
      ?.signIns?.accounts.find((row) => row.providerId === CLAUDE_PROVIDER_ID);
    expect(chosen?.modelAccounts.get(`${choice?.provider}/${choice?.id}`)).toBe(account?.id);
  });

  // FI3-1806: a computer that runs work builds its model lists as the home
  // does, so an Automatic start routes among what it actually serves.
  it("lists the Claude models that computer's own client answers, as the home lists its own", async () => {
    // A plan whose client there serves no Fable, and still lists an earlier Opus.
    const rows: ClaudeModelRow[] = [
      ...CLAUDE_CLIENT_ROWS.filter((row) => row.resolvedModel !== "claude-fable-5-1"),
      { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8" },
    ];
    const world = await joined({ claudeLogin: "live", claudeModels: rows });
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    await expect
      .poll(() => servedThere(world, CLAUDE_PROVIDER_ID))
      .toEqual(
        claudeServedModels(rows)
          .map((model) => model.id)
          .sort(),
      );
  });

  it("serves only the Codex models the account's own list names there, behind the home's rail", async () => {
    // Pi stays offline; the list is read at Codex's own address, which the stand-in answers.
    vi.stubEnv("INFINITARY_CODEX_MODELS_URL", CODEX_MODELS_URL);
    standInProviders();
    // The account's list names every starter row, and a model Pi has no definition for.
    const starters = Object.keys(STARTER_SLOTS["openai-codex"] ?? {});
    const world = await joined({ codexModels: [...starters, "gpt-7-preview"] });
    await signInToCodex(world);
    await expect.poll(() => servedThere(world, "openai-codex")).toEqual([...starters].sort());
  });

  // INF-84's review of FI3-1806: the rail protects what the captain kept, there as here.
  it("keeps a Codex model the captain pinned listed there when the account's own list leaves it out", async () => {
    vi.stubEnv("INFINITARY_CODEX_MODELS_URL", CODEX_MODELS_URL);
    standInProviders();
    const starters = Object.keys(STARTER_SLOTS["openai-codex"] ?? {});
    const world = await joined({ codexModels: starters });
    await signInToCodex(world);
    // The list there names only the starter rows, so it narrows every other model away.
    await expect.poll(() => servedThere(world, "openai-codex")).toEqual([...starters].sort());
    // The captain pins a model Pi serves that account, the way Models settings saves a pin.
    const { accounts } = await world.held();
    const account = accounts.vault.list().find((row) => row.providerId === "openai-codex");
    const pinned = accounts.vault
      .piCatalogIds(account?.id ?? "")
      ?.find((id) => !starters.includes(id));
    if (!pinned) throw new Error("Pi serves that account no model beyond its starter rows.");
    world.settings.setRoutingSettings({
      ...world.settings.getRoutingSettings(),
      pins: [{ provider: "codex", id: pinned }],
    });
    // A list that leaves out a kept model is not trusted to narrow anything, as here.
    expect(servedThere(world, "openai-codex")).toContain(pinned);
  });

  // INF-84's review of FI3-1806: a list read is tried again once a day, as here.
  it("asks Claude's client there for its model list at a sign-in, and not again with each allowance reading", async () => {
    const world = await joined({ claudeLogin: "live", claudeModels: "no answer" });
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    // The read settled as a failure, and the shipped catalog serves.
    await expect
      .poll(() =>
        world.logs.some((line) => line.startsWith(`${CLAUDE_PROVIDER_ID} model list unavailable`)),
      )
      .toBe(true);
    const { accounts } = await world.held();
    await accounts.readAllowance("interval");
    await accounts.readAllowance("interval");
    expect(world.claude.listReads).toBe(1);
  });

  // INF-142's review of FI3-1806: a read that waited on the store is no try.
  it("reads Claude's model list there once a session there lets go of the login's store", async () => {
    const world = await joined({ claudeLogin: "live" });
    // A crewmate's Claude session there holds the login's store, so a list read there waits.
    const release = await acquireSessionLease(world.claudeDir);
    const { signInId } = await world.signIns.start(world.deviceId, CLAUDE_PROVIDER_ID, "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const { accounts } = await world.held();
    const account = accounts.vault.list().find((row) => row.providerId === CLAUDE_PROVIDER_ID);
    if (!account) throw new Error("The computer kept no Claude account.");
    // The ended message precedes the sign-in's model-list and allowance work.
    // Keep the lease until that work finishes, not merely until the message arrives.
    await expect.poll(() => world.claude.allowanceReads.includes("sign-in")).toBe(true);
    expect(world.claude.listReads).toBe(0);
    // The session ends; the next allowance reading asks Claude's client for its list.
    release();
    await accounts.readAllowance("interval");
    await expect.poll(() => world.claude.listReads).toBe(1);
  });

  it("adopts the Claude login kept in that computer's saved passwords, and starts no sign-in over it", async () => {
    const saved = standInSavedPasswords({ allows: false });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["anthropic-claude"]);

    // No code was asked at home, and no sign-in ran there to replace the login.
    expect(world.steps(signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(world.claude.browser).toEqual([]);
    expect(world.claude.pasted).toEqual([]);
    // It looked in that computer's saved passwords, and never let macOS ask.
    expect(saved.queries.length).toBeGreaterThan(0);
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
  });

  it("asks Claude Code there before a new sign-in, and uses the login it says it has", async () => {
    // Nothing this computer reads shows the login, but Claude Code there is signed in.
    const world = await joined({ claudeLogin: "live", keychain: absentKeychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    expect(world.steps(signInId).some((step) => step.kind === "prompt")).toBe(false);
    expect(world.claude.browser).toEqual([]);
  });

  it("signs in to Claude with a link opened at home and the code it shows pasted back", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    // The link goes home, to open in the captain's browser there.
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice" && step.notice.url))
      .toMatchObject({ notice: { kind: "auth_url", url: CLAUDE_CODE_PAGE } });
    const paste = await world.prompt(signInId);
    expect(paste.kind).toBe("manual_code");
    await world.signIns.answer(signInId, paste.promptId, CLAUDE_CODE);
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });

    // Claude's client there took the code once, and opened no browser there.
    expect(world.claude.pasted).toEqual([CLAUDE_CODE]);
    expect(world.claude.browser).toEqual([NO_BROWSER]);
    await expect
      .poll(() => world.group()?.signIns?.accounts.map((account) => account.providerId))
      .toEqual(["anthropic-claude"]);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: "device_signed_in", who: "Builder", provider: "Claude" }),
    );
    // Nothing the home said, pushed or saved holds the code.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      CLAUDE_CODE,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(CLAUDE_CODE))).toEqual([]);
  });

  it("says Claude's own words when the pasted code is refused, and signs nothing in", async () => {
    const world = await joined({ claudeLogin: "absent" });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    await world.signIns.answer(signInId, (await world.prompt(signInId)).promptId, "wrong");
    expect(await world.ended(signInId)).toMatchObject({
      outcome: "failed",
      error: "Login failed: Invalid authorization code",
    });
    expect(world.group()?.signIns?.accounts ?? []).toEqual([]);
  });

  it("reads Claude's allowance there with that computer's own login, and asks macOS nothing", async () => {
    const saved = standInSavedPasswords({ allows: true });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });

    // The reading lands at home in the account's row, read with the login there.
    await expect
      .poll(() =>
        world.group()?.signIns?.quota?.providers.find((row) => row.accountId === account.id),
      )
      .toMatchObject({
        provider: "claude",
        status: "ok",
        windows: [expect.objectContaining({ percentRemaining: 73 })],
      });
    expect(world.allowance.asked).toContainEqual({
      url: "https://api.anthropic.com/api/oauth/usage",
      auth: `Bearer ${CLAUDE_ACCESS}`,
    });
    // Neither the sign-in nor the reading let macOS ask on that screen.
    expect(saved.queries.length).toBeGreaterThan(0);
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
    // The login stays there: nothing the home heard or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      CLAUDE_ACCESS,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(CLAUDE_ACCESS))).toEqual([]);
  });

  it("says at home why Claude's allowance is not read there when macOS would have to ask", async () => {
    const saved = standInSavedPasswords({ allows: false });
    const world = await joined({ claudeLogin: "live", keychain: saved.keychain });
    const { signInId } = await world.signIns.start(world.deviceId, "anthropic-claude", "oauth");
    expect(await world.ended(signInId)).toMatchObject({ outcome: "signed-in" });
    const account = await vi.waitFor(() => {
      const found = world.group()?.signIns?.accounts[0];
      if (!found) throw new Error("not yet");
      return found;
    });
    const row = () =>
      world.group()?.signIns?.quota?.providers.find((entry) => entry.accountId === account.id);

    // Not "reading" with no end: the row says why, in words for a computer.
    await expect.poll(row).toMatchObject({
      status: "unavailable",
      reason: "keychain_needs_grant",
      detail: KEYCHAIN_VALUE_FAILURE_THERE.keychain_needs_grant,
      windows: [],
    });
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
    expect(world.allowance.asked.map((asked) => asked.url)).not.toContain(
      "https://api.anthropic.com/api/oauth/usage",
    );

    // The refusal is not held: once macOS there lets it read, the next reading shows.
    saved.allow();
    await (await world.held()).accounts.readAllowance("interval");
    await expect.poll(row).toMatchObject({
      status: "ok",
      windows: [expect.objectContaining({ percentRemaining: 73 })],
    });
    expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
  });

  it("stops a sign-in when the home stops it, and when the computer goes out of reach", async () => {
    const world = await joined();
    const first = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    await world.prompt(first.signInId);
    await world.signIns.cancel(first.signInId);
    expect(await world.ended(first.signInId)).toMatchObject({ outcome: "cancelled" });

    const second = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    const asked = await world.prompt(second.signInId);
    // The connection goes: nobody can answer it there now.
    await world.connection.close();
    expect(await world.ended(second.signInId)).toMatchObject({
      outcome: "failed",
      error: "Builder went out of reach, so the sign-in stopped.",
    });
    await expect(world.signIns.answer(second.signInId, asked.promptId, KEY)).rejects.toThrow(
      "no longer running",
    );
    await expect(world.signIns.start(world.deviceId, "openrouter", "api_key")).rejects.toThrow(
      "Builder is out of reach, so no sign-in started.",
    );
    expect(world.group()?.signIns?.accounts).toEqual([]);
  });

  it("replaces an account flow from overlapping callers on the computer, not just in Settings", async () => {
    const computerSteps: { signInId: string; step: SignInStep }[] = [];
    const world = await joined({
      onStep: (signInId, step) => computerSteps.push({ signInId, step }),
    });
    const pending = world.signIns.start(world.deviceId, "openrouter", "api_key");
    const replacement = world.signIns.start(world.deviceId, "openrouter", "api_key");
    const [first, second] = await Promise.all([pending, replacement]);
    await expect
      .poll(() =>
        computerSteps
          .filter((event) => event.signInId === first.signInId && event.step.kind === "ended")
          .map((event) => event.step),
      )
      .toEqual([{ kind: "ended", outcome: "cancelled" }]);
    expect(world.group()?.flows?.map((flow) => flow.signInId)).toEqual([second.signInId]);
    await world.signIns.answer(
      second.signInId,
      (await world.prompt(second.signInId)).promptId,
      KEY,
    );
    expect(await world.ended(second.signInId)).toMatchObject({ outcome: "signed-in" });
    expect((await (await world.held()).accounts.vault.views()).length).toBe(1);
  });

  // Reconnect must release the computer's work, not only the home's view.
  it.each(["account", "forge"] as const)(
    "cancels the computer's %s flow through a real quick redial and permits a fresh sign-in",
    async (target) => {
      const github = target === "forge" ? standInGitHub({ hold: true }) : undefined;
      const sockets: WebSocket[] = [];
      const contactsAtDial: (string | undefined)[] = [];
      const computerSteps: { signInId: string; step: SignInStep }[] = [];
      let state: (() => ReturnType<HelperRun["state"]>) | undefined;
      const world = await joined({
        dial: async (grant) => {
          contactsAtDial.push(state?.().contact);
          const socket = await dialHome(grant);
          sockets.push(socket);
          return socket;
        },
        onStep: (signInId, step) => computerSteps.push({ signInId, step }),
      });
      state = world.state;
      world.signIns.read();
      await expect.poll(() => world.group()?.signIns?.forges?.hosts.length).toBe(1);
      const start = () =>
        target === "account"
          ? world.signIns.start(world.deviceId, "openrouter", "api_key")
          : world.signIns.startForge(world.deviceId, "github.com");
      const first = await start();
      const prompt = target === "account" ? await world.prompt(first.signInId) : undefined;
      if (target === "forge")
        await expect
          .poll(() => world.steps(first.signInId).some((step) => step.kind === "notice"))
          .toBe(true);
      const socket = sockets.at(-1);
      if (!socket) throw new Error("The computer has no connected socket");
      socket.terminate();
      await expect
        .poll(() =>
          computerSteps
            .filter((event) => event.signInId === first.signInId && event.step.kind === "ended")
            .map((event) => event.step),
        )
        .toEqual([{ kind: "ended", outcome: "cancelled" }]);
      expect(contactsAtDial).toEqual([undefined, "in-reach"]);
      expect(world.state().contact).toBe("in-reach");
      expect(world.group()?.flows?.[0]).toMatchObject({
        signInId: first.signInId,
        phase: "ended",
        ended: { outcome: "failed" },
      });
      const held = await world.held();
      await held.accounts.vault.swept();
      expect(await held.accounts.vault.views()).toEqual([]);
      expect(held.forges.view().signIns).toEqual([]);
      if (prompt)
        await expect(
          held.host.answer("inf:sign-ins:answer", [
            { signInId: first.signInId, promptId: prompt.promptId, value: KEY },
          ]),
        ).rejects.toThrow("no longer waiting");
      const second = await start();
      if (target === "account")
        await world.signIns.answer(
          second.signInId,
          (await world.prompt(second.signInId)).promptId,
          KEY,
        );
      else github?.approve();
      expect(await world.ended(second.signInId)).toMatchObject({ outcome: "signed-in" });
      expect(world.events.filter((event) => event.type === "device_signed_in")).toHaveLength(1);
    },
  );

  it("signs in to GitHub with a code read at home, which the computer finishes and its git uses", async () => {
    const github = standInGitHub();
    const askpass = join(__dirname, "../../../resources/git-askpass");
    const world = await joined({ gitAskpass: askpass });
    world.signIns.read();
    // It offers GitHub, and is not signed in there yet.
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });

    const { signInId } = await world.signIns.startForge(world.deviceId, "github.com");
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: {
          kind: "device_code",
          userCode: "WDJB-0042",
          url: "https://github.com/login/device",
        },
      });
    // Nobody types anything: the computer asks GitHub until it says yes.
    expect(await world.ended(signInId)).toEqual({ kind: "ended", outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        {
          host: "github.com",
          name: "GitHub",
          login: "octo-mini",
          state: "ok",
          since: expect.any(Number),
        },
      ]);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: "device_signed_in", who: "Builder", provider: "GitHub" }),
    );
    // GitHub was asked who it is with the computer's own sign-in.
    expect(github.asked).toContainEqual({
      url: "https://api.github.com/user",
      auth: `Bearer ${GITHUB_SIGN_IN}`,
    });

    // The sign-in is in the computer's own store, which its git's helper reads.
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("github.com")).toMatchObject({
      token: GITHUB_SIGN_IN,
      login: "octo-mini",
    });
    expect(statSync(join(forges, "github.com", "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(hostEnv()).toMatchObject({
      GIT_ASKPASS: askpass,
      INFINITARY_GIT_SIGNIN_DIR: forges,
      GIT_TERMINAL_PROMPT: "0",
    });
    // Nothing the home said, pushed or saved holds it.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      GITHUB_SIGN_IN,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(GITHUB_SIGN_IN))).toEqual(
      [],
    );

    // Its health is read there: GitHub refusing it is a sign-in again at home.
    github.refuse();
    await (await world.held()).forges.checkHealth();
    await expect.poll(() => world.group()?.signIns?.forges?.signIns[0]?.state).toBe("needs_reauth");

    // Signing it out from home deletes it there.
    await world.signIns.signOutForge(world.deviceId, "github.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "github.com"))).toBe(false);
  });

  // The captain's ask (INF-3145): a separate computer's own GitHub sign-in
  // offers what this Mac's does, the GitHub CLI sign-in already on it.
  it("signs a computer in to GitHub through its own GitHub CLI, keeping only the way", async () => {
    const github = standInGitHub();
    // GitHub CLI there, as `gh auth token --hostname <host>` answers: signed in to github.com alone.
    const gh = "/opt/homebrew/bin/gh";
    let cliSignedIn = true;
    const asked: string[] = [];
    const githubCli: GitHubCli = {
      find: () => gh,
      token: async (program, host) => {
        asked.push(`${program} ${host}`);
        return cliSignedIn && host === "github.com"
          ? { token: GITHUB_CLI_SIGN_IN }
          : { problem: "none", reason: `GitHub CLI holds no sign-in for ${host}` };
      },
    };
    const world = await joined({ githubCli });
    world.signIns.read();
    // It says GitHub CLI is there, and is not signed in yet.
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        githubCli: true,
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });

    expect(await world.signIns.forgeWithCli(world.deviceId, "github.com")).toEqual({
      ok: true,
      host: "github.com",
    });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        {
          host: "github.com",
          name: "GitHub",
          login: "octo-mini",
          state: "ok",
          since: expect.any(Number),
          way: "cli",
        },
      ]);
    // GitHub was asked who it is with GitHub CLI's sign-in, there.
    expect(github.asked).toContainEqual({
      url: "https://api.github.com/user",
      auth: `Bearer ${GITHUB_CLI_SIGN_IN}`,
    });
    // The computer's store names the way and the program, never the token.
    const forges = join(world.dataDir, "forges");
    const file = readFileSync(join(forges, "github.com", "sign-in.json"), "utf8");
    expect(JSON.parse(file)).toMatchObject({ way: "cli", program: gh, login: "octo-mini" });
    expect(file).not.toContain(GITHUB_CLI_SIGN_IN);
    // Only the program the store names was asked, for github.com; its git's helper reads the same file.
    expect(new Set(asked)).toEqual(new Set([`${gh} github.com`]));
    // Nothing the home said, pushed or saved holds it, nor the computer's log.
    expect(
      JSON.stringify([world.emitted, world.events, world.signIns.view(), world.logs]),
    ).not.toContain(GITHUB_CLI_SIGN_IN);
    expect(
      savedText(world.homeDir).filter(({ text }) => text.includes(GITHUB_CLI_SIGN_IN)),
    ).toEqual([]);

    // A host GitHub CLI holds no sign-in for is not kept, and says why.
    await world.signIns.signOutForge(world.deviceId, "github.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    cliSignedIn = false;
    expect(await world.signIns.forgeWithCli(world.deviceId, "github.com")).toEqual({
      ok: false,
      problem: "none",
      host: "github.com",
    });
    expect(existsSync(join(forges, "github.com"))).toBe(false);
  });

  // INF-4280's audit item 7: a computer signs in to GitHub Enterprise and
  // GitLab from home, not github.com alone.
  it("signs a computer in to GitHub Enterprise with a key typed at home, which it keeps and its git answers that host with", async () => {
    const servers = standInServers();
    const askpass = join(__dirname, "../../../resources/git-askpass");
    const world = await joined({ gitAskpass: askpass });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);

    // A key the server does not answer for is not kept there.
    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "github",
        address: "https://github.example.com/acme/api",
        key: "ghp_standin_revoked_0042",
      }),
    ).toEqual({ ok: false, problem: "refused", host: "github.example.com" });
    expect(existsSync(join(world.dataDir, "forges", "github.example.com"))).toBe(false);

    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "github",
        address: "https://github.example.com/acme/api",
        key: ENTERPRISE_KEY,
      }),
    ).toEqual({ ok: true, host: "github.example.com" });
    // Its row is the host's own address, signed in as who the server says.
    expect(world.group()?.signIns?.forges?.signIns).toEqual([
      expect.objectContaining({
        host: "github.example.com",
        name: "github.example.com",
        login: "mona",
        state: "ok",
        server: GITHUB_ENTERPRISE,
      }),
    ]);
    expect(world.group()?.signIns?.forges?.hosts).toContainEqual({
      host: "github.example.com",
      name: "github.example.com",
      server: GITHUB_ENTERPRISE,
    });

    // The key is in the computer's own store, which its git answers that host from alone.
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("github.example.com")).toMatchObject({
      token: ENTERPRISE_KEY,
      kind: "github",
      gitUser: "x-access-token",
    });
    expect(statSync(join(forges, "github.example.com", "sign-in.json")).mode & 0o777).toBe(0o600);
    expect(hostEnv()).toMatchObject({ GIT_ASKPASS: askpass, INFINITARY_GIT_SIGNIN_DIR: forges });
    expect(hostEnv().GIT_CONFIG_PARAMETERS).toContain(
      "'credential.https://github.example.com.helper='",
    );
    // Nothing the home said, pushed or saved holds the key.
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      ENTERPRISE_KEY,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(ENTERPRISE_KEY))).toEqual(
      [],
    );
    expect(servers.asked).toContainEqual({
      url: "https://github.example.com/api/v3/user",
      auth: expect.stringContaining(ENTERPRISE_KEY),
    });

    // Signing it out from home deletes it there.
    await world.signIns.signOutForge(world.deviceId, "github.example.com");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "github.example.com"))).toBe(false);
  });

  it("signs a computer in to GitLab on the person's own server with a browser code read at home", async () => {
    const servers = standInServers();
    const world = await joined({ gitAskpass: join(__dirname, "../../../resources/git-askpass") });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);
    // Until then its git keeps the computer's own login for every GitLab
    // host, gitlab.com included (review of INF-4287, the captain's choice:
    // only a host with a sign-in here is answered by the app alone).
    const helpers = () => hostEnv().GIT_CONFIG_PARAMETERS ?? "";
    expect(helpers()).toContain("'credential.https://github.com.helper='");
    expect(helpers()).not.toContain("gitlab");

    const { signInId } = await world.signIns.forgeBrowser(world.deviceId, {
      kind: "gitlab",
      address: "gitlab.example.com",
      applicationId: GITLAB_APPLICATION,
    });
    await expect
      .poll(() => world.steps(signInId).find((step) => step.kind === "notice"))
      .toMatchObject({
        notice: {
          providerId: "gitlab.example.com",
          kind: "device_code",
          userCode: "GLAB-0042",
          url: "https://gitlab.example.com/oauth/device",
        },
      });
    // The captain enters the code on GitLab's page; the computer asks until it says yes.
    expect(await world.ended(signInId)).toEqual({ kind: "ended", outcome: "signed-in" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        expect.objectContaining({
          host: "gitlab.example.com",
          login: "tanuki",
          state: "ok",
          server: GITLAB,
          applicationId: GITLAB_APPLICATION,
        }),
      ]);
    expect(
      new ForgeSignInStore(join(world.dataDir, "forges")).read("gitlab.example.com"),
    ).toMatchObject({
      token: GITLAB_SIGN_IN,
      kind: "gitlab",
      gitUser: "oauth2",
      applicationId: GITLAB_APPLICATION,
    });
    // Signed in, that host is answered by the app's sign-in alone; gitlab.com,
    // with none here, still keeps the computer's own.
    expect(helpers()).toContain("'credential.https://gitlab.example.com.helper='");
    expect(helpers()).not.toContain("'credential.https://gitlab.com.helper='");
    expect(servers.asked).toContainEqual({
      url: "https://gitlab.example.com/api/v4/user",
      auth: `Bearer ${GITLAB_SIGN_IN}`,
    });
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      GITLAB_SIGN_IN,
    );
  });

  // INF-5192: each computer's own Bitbucket sign-in, made with an API token typed at home.
  it("signs a computer in to Bitbucket with an API token typed at home, which its git answers bitbucket.org with", async () => {
    const servers = standInServers();
    const world = await joined({ gitAskpass: join(__dirname, "../../../resources/git-askpass") });
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges?.servers)
      .toEqual([GITHUB_ENTERPRISE, GITLAB, BITBUCKET]);
    // Until then its git keeps the computer's own login for bitbucket.org.
    const helpers = () => hostEnv().GIT_CONFIG_PARAMETERS ?? "";
    expect(helpers()).not.toContain("bitbucket");

    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "bitbucket",
        address: "bitbucket.org",
        key: "ATATT3xFfGF0standin_revoked-0042=FFFF0000",
      }),
    ).toEqual({ ok: false, problem: "refused", host: "bitbucket.org" });
    expect(existsSync(join(world.dataDir, "forges", "bitbucket.org"))).toBe(false);
    expect(
      await world.signIns.forgeWithKey(world.deviceId, {
        kind: "bitbucket",
        address: "https://bitbucket.org/team/api",
        key: BITBUCKET_KEY,
      }),
    ).toEqual({ ok: true, host: "bitbucket.org" });
    await expect
      .poll(() => world.group()?.signIns?.forges?.signIns)
      .toEqual([
        expect.objectContaining({
          host: "bitbucket.org",
          name: "Bitbucket",
          login: "octo",
          state: "ok",
          server: BITBUCKET,
        }),
      ]);
    const forges = join(world.dataDir, "forges");
    expect(new ForgeSignInStore(forges).read("bitbucket.org")).toMatchObject({
      token: BITBUCKET_KEY,
      kind: "bitbucket",
      gitUser: "x-bitbucket-api-token-auth",
    });
    expect(statSync(join(forges, "bitbucket.org", "sign-in.json")).mode & 0o777).toBe(0o600);
    // Signed in, bitbucket.org is answered by the app's sign-in alone there.
    expect(helpers()).toContain("'credential.https://bitbucket.org.helper='");
    expect(servers.asked).toContainEqual({
      url: "https://api.bitbucket.org/2.0/user",
      auth: `Bearer ${BITBUCKET_KEY}`,
    });
    expect(JSON.stringify([world.emitted, world.events, world.signIns.view()])).not.toContain(
      BITBUCKET_KEY,
    );
    expect(savedText(world.homeDir).filter(({ text }) => text.includes(BITBUCKET_KEY))).toEqual([]);

    await world.signIns.signOutForge(world.deviceId, "bitbucket.org");
    await expect.poll(() => world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(forges, "bitbucket.org"))).toBe(false);
    expect(helpers()).not.toContain("bitbucket");
  });

  it("offers no GitHub CLI sign-in on a computer without GitHub CLI", async () => {
    const world = await joined();
    world.signIns.read();
    await expect
      .poll(() => world.group()?.signIns?.forges)
      .toEqual({
        signIns: [],
        hosts: [{ host: "github.com", name: "GitHub" }],
        servers: [GITHUB_ENTERPRISE, GITLAB, BITBUCKET],
      });
    await expect(world.signIns.forgeWithCli(world.deviceId, "github.com")).rejects.toThrow(
      "does not offer GitHub CLI's sign-in there",
    );
  });

  it("stops a GitHub sign-in when the home stops it, and says when its code ran out", async () => {
    let expired = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url === "https://github.com/login/device/code")
        return json({
          device_code: "standin-github-device",
          user_code: "WDJB-0043",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 1,
        });
      return json({ error: expired ? "expired_token" : "authorization_pending" });
    });
    const world = await joined();
    world.signIns.read();
    await expect.poll(() => world.group()?.signIns?.forges?.hosts.length).toBe(1);

    const stopped = await world.signIns.startForge(world.deviceId, "github.com");
    await expect
      .poll(() => world.steps(stopped.signInId).some((step) => step.kind === "notice"))
      .toBe(true);
    await world.signIns.cancel(stopped.signInId);
    expect(await world.ended(stopped.signInId)).toEqual({ kind: "ended", outcome: "cancelled" });

    expired = true;
    const lapsed = await world.signIns.startForge(world.deviceId, "github.com");
    expect(await world.ended(lapsed.signInId)).toEqual({
      kind: "ended",
      outcome: "failed",
      error: "The code expired.",
    });
    expect(world.group()?.signIns?.forges?.signIns).toEqual([]);
    expect(existsSync(join(world.dataDir, "forges", "github.com"))).toBe(false);
  });

  it("answers a sign-in step only from the computer it runs on", async () => {
    const world = await joined();
    const { signInId } = await world.signIns.start(world.deviceId, "openrouter", "api_key");
    expect(() =>
      world.signIns.step("another-device", {
        signInId,
        step: { kind: "ended", outcome: "signed-in" },
      }),
    ).toThrow("No sign-in of this home runs on that computer.");
    expect(() =>
      world.signIns.changed("another-device", { providers: [], accounts: [], quota: null }),
    ).toThrow("No computer that runs work has that id");
  });
});
