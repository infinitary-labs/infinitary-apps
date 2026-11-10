import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ClaudeAuthBackendOptions } from "../../src/core/claude/claudeAuth";
import { NO_BROWSER } from "../../src/core/claude/claudeCli";
import { startComputerAccounts } from "../../src/core/helper/accounts";
import { joinHome } from "../../src/core/helper/join";
import { startSignIns } from "../../src/core/helper/signIns";
import type { HostKeychain, HostKeychainQuery } from "../../src/core/host";
import { configureGitSignIn, hostEnv } from "../../src/core/hostEnv";
import { catalogRefreshesSettled } from "../../src/core/pi/modelRuntime";
import type { QuotaHttp } from "../../src/core/quota/http";
import { DEVICE_FORGE_ROLE } from "../../src/renderer/src/settings/deviceForgeWords";
import { CLAUDE_CLIENT_MISSING_TEXT } from "../../src/shared/claudeClient";
import { deviceSetupTitle } from "../../src/shared/deviceSetup";
import { FORGE_CLI_WORDS, forgeCliOffer } from "../../src/shared/forges";
import { INTEGRATIONS_WORDS } from "../../src/shared/integrations";
import { signInPlace } from "../../src/shared/signIns";
import { scratchDir } from "../helpers/scratchDirs";
import { customApiBlock, fillCustomApi, saveCustomApi } from "./customApi";
import { startCustomApiFixture } from "./customApiFixture";
import { type GitHubStub, STUB_USER_CODE, seedGitHubSignIn, startGitHubStub } from "./githubStub";
import { FIRST_CONTACT_TIMEOUT_MS } from "./helperContact";
import { type HelperRun, startHelper } from "./helperRun";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import {
  closeModelPanel,
  levelLane,
  openModelPanel,
  openModelsBoard,
  setLevelInPanel,
} from "./modelsBoard";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { feedLineOf } from "./rails";
import { savedText } from "./savedText";
import { expectNoCard, shownCard } from "./stack";

/**
 * A computer that runs work signs in to its own subscriptions from the Mac
 * where Firstmate lives (docs/helper.md, "Its own sign-ins"; design skill
 * `components/devices/SignInOnAMac`): Settings -> Intelligence lists it in
 * its own group, its chips start a sign-in there, the aside draws the flow
 * that runs there, Firstmate's card opens it with the sign-in started, and
 * the allowance it reads shows in its row. What the captain types goes to
 * that computer once: nothing the home saves holds it.
 *
 * Settings -> Projects does the same for the computer's own GitHub sign-in,
 * which its clones and pushes use: GitHub's code to read is drawn here, and
 * the computer finishes the sign-in and its git answers GitHub with it.
 *
 * The home is the built app. The computer is the helper as the work mode
 * composes it, in this test's own process, joined as another macOS user on
 * this Mac; its providers are stand-ins answered here, GitHub is the local
 * stand-in, and Claude's client is a script, so nothing reaches the network
 * and nobody signs in to anything real.
 */

const KEY = "sk-or-v1-e2e-typed-key-7731";
/** The code inside the address Codex's page sends the browser back to. */
const PASTED = "e2e-pasted-code-7731";
/** The code Claude's page shows, pasted back here. */
const CLAUDE_CODE = "e2e-claude-code#state-7731";
const CLAUDE_CODE_PAGE =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s7731";
/** GitHub's sign-in for the computer's approved code, never the home's own. */
const COMPUTER_GITHUB = "gho_e2e_computer_7731";
/** What GitHub CLI on the computer prints for github.com: its own sign-in, never one the app made. */
const COMPUTER_GITHUB_CLI = "gho_e2e_computer_cli_7731";
const ASKPASS = join(process.cwd(), "resources", "git-askpass");
/** Another macOS user on this Mac, as the computer says it runs as. */
const BUILDER = { name: "builder", uid: (process.getuid?.() ?? userInfo().uid) + 1000 };
/** How the home names that computer in its sign-ins ("Builder"). */
const PLACE = signInPlace({ name: "Mac mini", user: BUILDER.name, onThisMac: true });

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const CODEX_ACCESS = token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-e2e" } });

/**
 * Grok's and Codex's sign-in endpoints as Pi asks them in this process,
 * answered here; nothing else leaves this Mac.
 */
function standInProviders(): () => void {
  const real = globalThis.fetch;
  let grokPending = 1;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // The local GitHub stand-in, which the computer in this process asks too.
    if (url.startsWith("http://127.0.0.1:")) return real(input, init);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://auth.x.ai/oauth2/device/code")
      return json(200, {
        device_code: "e2e-device",
        user_code: "WXYZ-7731",
        verification_uri: "https://accounts.x.ai/device",
        expires_in: 600,
        interval: 1,
      });
    if (url === "https://auth.x.ai/oauth2/token")
      return grokPending-- > 0
        ? json(400, { error: "authorization_pending" })
        : json(200, { access_token: "e2e-grok", refresh_token: "e2e-grok-r", expires_in: 3600 });
    if (url === "https://auth.openai.com/oauth/token")
      return json(200, {
        access_token: CODEX_ACCESS,
        refresh_token: "e2e-codex-r",
        expires_in: 3600,
      });
    return json(404, {});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** The access in the Claude login Claude Code keeps on the computer. */
const COMPUTER_CLAUDE = "e2e-claude-access-7731";

/** The share of Codex's session the stand-in reads as used; its row shows the rest left. */
const CODEX_USED = 12;
/** The share of Claude's session used, for the computer's own login alone. */
const CLAUDE_USED = 27;

/** The allowance's stand-in readings, `CODEX_USED` and `CLAUDE_USED`. */
const allowance: QuotaHttp = async (url, init) => {
  if (url === "https://chatgpt.com/backend-api/wham/usage")
    return {
      status: 200,
      json: {
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: CODEX_USED,
            limit_window_seconds: 18_000,
            reset_after_seconds: 3_600,
          },
        },
      },
    };
  if (url === "https://api.anthropic.com/api/oauth/usage")
    return init.headers?.Authorization === `Bearer ${COMPUTER_CLAUDE}`
      ? {
          status: 200,
          json: {
            five_hour: {
              utilization: CLAUDE_USED,
              resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
            },
          },
        }
      : { status: 401 };
  return { status: 404 };
};

/**
 * The computer's saved passwords, where Claude Code keeps its login: a read
 * macOS would not ask about gets that login, and one macOS would have to ask
 * about is refused, as macOS refuses it. Every query is written down. They
 * hold the login while `holds` says so: from the start, or once Claude Code
 * there has signed in and kept it.
 */
function savedPasswords(allows: boolean, holds: () => boolean = () => true) {
  const queries: HostKeychainQuery[] = [];
  const login = JSON.stringify({
    claudeAiOauth: {
      accessToken: COMPUTER_CLAUDE,
      expiresAt: Date.now() + 3_600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86_400_000,
    },
  });
  const keychain: HostKeychain = {
    findGenericPassword: async (query) => {
      queries.push(query);
      if (!holds()) return { kind: "absent" };
      return { kind: "found", modifiedAt: "20261004120000Z", locked: false };
    },
    readGenericPassword: async (query) => {
      queries.push(query);
      if (!holds()) return { kind: "absent" };
      return allows
        ? { kind: "value", value: login }
        : { kind: "failed", code: -25308, message: "User interaction is not allowed." };
    },
  };
  return { keychain, queries };
}

/** Replaces the system browser here with a recorder of the links it is asked to open. */
function recordOpens(launched: LaunchedApp) {
  return launched.app.evaluate(({ shell }) => {
    const recorded: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = recorded;
    shell.openExternal = async (url: string) => {
      recorded.push(url);
    };
  });
}

function opened(launched: LaunchedApp): Promise<string[]> {
  return launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);
}

/** The address a browser ends on once the provider approves `code` for a sign-in `link`. */
function browserEndsOn(link: string, code: string): string {
  const asked = new URL(link);
  const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
  back.search = new URLSearchParams({
    code,
    state: asked.searchParams.get("state") ?? "",
  }).toString();
  return back.toString();
}

async function ask(page: Page, action: string, value: unknown) {
  const input = promptInput(page);
  await input.fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
  await input.press("Enter");
}

/**
 * Claude's client on the computer, as a script that prints what Claude Code
 * 2.1.288 prints with no terminal and waits for the code on stdin. Its store
 * is read as in production: who the login is beside it in its folder, and the
 * login itself in the saved passwords a test stands in, never a login file.
 */
function scriptedClaude(loggedIn = false) {
  const seen = { loggedIn, browser: [] as unknown[], pasted: [] as unknown[] };
  const configDir = scratchDir("infinitary-e2e-computer-claude-");
  writeFileSync(
    join(configDir, ".config.json"),
    // As Claude Code keeps it: which account the login is, never the login itself.
    JSON.stringify({
      oauthAccount: { emailAddress: "builder@example.com", accountUuid: "e2e-builder-account" },
    }),
  );
  const options: ClaudeAuthBackendOptions = {
    available: () => true,
    configDir: () => configDir,
    run: async (args, _dir, run) => {
      if (args[0] === "auth" && args[1] === "login") {
        seen.browser.push(run?.env?.BROWSER);
        run?.onStdout?.(`If the browser didn't open, visit: ${CLAUDE_CODE_PAGE}\n`);
        run?.onStdout?.("Paste code here if prompted > ");
        const code = await run?.paste;
        seen.pasted.push(code);
        seen.loggedIn = code === CLAUDE_CODE;
        return { code: seen.loggedIn ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "logout") {
        seen.loggedIn = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ loggedIn: seen.loggedIn }), stderr: "" };
    },
  };
  return { options, seen };
}

let restoreFetch: (() => void) | undefined;
let github: GitHubStub | undefined;
const runs: HelperRun[] = [];
const apps: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.stop()));
  await catalogRefreshesSettled();
  for (const app of apps.splice(0)) await app.close();
  restoreFetch?.();
  restoreFetch = undefined;
  await github?.close();
  github = undefined;
  delete process.env.INFINITARY_GITHUB_OAUTH_URL;
  delete process.env.INFINITARY_GITHUB_API_URL;
  // The computer in this process pointed its git at its own store.
  configureGitSignIn(undefined);
});

/** The home, and a computer joined to it as another user on this Mac, running. */
async function homeAndComputer(
  options: {
    claude?: ClaudeAuthBackendOptions;
    github?: GitHubStub;
    keychain?: HostKeychain;
    /** GitHub CLI on that computer, by its path; none otherwise, so the one on this Mac is never found. */
    githubCli?: string;
  } = {},
) {
  process.env.PI_OFFLINE = "1";
  // The computer in this process finds GitHub CLI only where the test put one.
  process.env.INFINITARY_GITHUB_CLI = options.githubCli ?? "none";
  // Codex's own callback page would listen on this Mac; the pasted code is the path here.
  process.env.PI_OAUTH_CALLBACK_HOST = "203.0.113.1";
  restoreFetch = standInProviders();
  // The computer in this process asks the same GitHub stand-in the home does.
  if (options.github) Object.assign(process.env, options.github.env);
  const userDataDir = scratchDir("infinitary-e2e-");
  // The home is signed in to GitHub with its own sign-in.
  if (options.github) seedGitHubSignIn(userDataDir);
  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    ...(options.github ? { env: options.github.env } : {}),
  });
  apps.push(app);
  const { page } = app;
  // The home makes a link for a computer that runs work in its own window
  // (the Devices tab's command panel is piece 12).
  const invite = await page.evaluate(() => window.infinitary.devices.invite({ kind: "work" }));
  const dataDir = scratchDir("infinitary-e2e-computer-");
  const joined = await joinHome({
    text: invite.link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: BUILDER },
    timeoutMs: 5_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [50],
    log: () => {},
    // Every git it starts answers GitHub with its own sign-in.
    gitAskpass: ASKPASS,
    // Its saved passwords, where Claude Code keeps its login there.
    ...(options.keychain ? { keychain: options.keychain } : {}),
    signIns: (start) =>
      startSignIns({
        ...start,
        accounts: (accountsOptions) =>
          startComputerAccounts({
            ...accountsOptions,
            http: allowance,
            clock: false,
            // No Claude Code on that computer, unless the test puts its script there.
            claude: options.claude ?? { available: () => false },
            // Its model list is never this Mac's own client's: the script answers
            // none, so a Claude account there lists Claude's shipped catalog.
            claudeList: {
              read: async () => {
                throw new Error(CLAUDE_CLIENT_MISSING_TEXT);
              },
            },
          }),
      }),
  });
  if (!started.ok) throw new Error(started.reason);
  runs.push(started.run);
  await expect
    .poll(() => started.run.state().contact, { timeout: FIRST_CONTACT_TIMEOUT_MS })
    .toBe("in-reach");
  // The join raises the computer's setup card (device-setup.spec.ts is its
  // journey); this spec's subject is the sign-in itself, so Not now.
  const setup = deviceSetupTitle(
    signInPlace({ name: "Mac mini", user: BUILDER.name, onThisMac: true }),
  );
  await expect(shownCard(page, setup)).toBeVisible();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expectNoCard(page, setup);
  return { app, page, deviceId: joined.grant.deviceId, dataDir };
}

async function openIntelligence(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
}

test("a computer signs in to its own subscriptions from Settings here, and nothing typed is kept here", async () => {
  const { app, page, deviceId, dataDir } = await homeAndComputer();
  await openIntelligence(page);

  // The computer has a group of its own.
  const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
  await expect(group).toBeVisible();
  await expect(group.locator("[data-device-no-sign-ins]")).toBeVisible();
  // No Claude Code there, so its chip cannot start one.
  await expect(group.locator('[data-connect-provider="anthropic-claude"]')).toBeDisabled();

  // A key, typed here and sent there once.
  await group.locator('[data-connect-provider="openrouter"]').click();
  await group.getByRole("button", { name: "API key", exact: true }).click();
  const aside = group.locator('[data-device-sign-in-provider="openrouter"]');
  const send = aside.getByRole("button", { name: `Send to ${PLACE.who}`, exact: true });
  await expect(send).toBeDisabled();
  // The captain's accepted row 6: the home owns the prompt, not this mounted tab.
  const [before] = await page.evaluate(() => window.infinitary.devices.signIns());
  const signInId = before?.flows?.find((flow) => flow.target === "account")?.signInId;
  expect(signInId).toBeTruthy();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(group).toHaveCount(0);
  await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
  await expect(aside.getByLabel(`The key for ${PLACE.who}`)).toBeVisible();
  await expect(aside.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  const [after] = await page.evaluate(() => window.infinitary.devices.signIns());
  expect(after?.flows?.find((flow) => flow.target === "account")?.signInId).toBe(signInId);
  await aside.getByLabel(`The key for ${PLACE.who}`).fill(KEY);
  await send.click();
  await expect(group.locator("[data-account-row]")).toHaveCount(1);
  await expect(group.locator('[data-account-row]:has-text("OpenRouter")')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, {
      type: "device_signed_in",
      deviceId,
      who: PLACE.who,
      provider: "OpenRouter",
    }),
  ).toBeVisible();

  // Firstmate's card opens the tab with the sign-in already started there:
  // a code to read here, which the computer finishes itself.
  await ask(page, "device-sign-in", { deviceId, provider: "xai" });
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(page.getByRole("tab", { name: "Intelligence", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Grok signs in either way, so it asks which first, as it does for this Mac.
  await group.getByRole("button", { name: "Sign in with your browser", exact: true }).click();
  const grok = group.locator('[data-device-sign-in-provider="xai"]');
  await expect(grok.locator("[data-device-sign-in-code]")).toHaveText("WXYZ-7731");
  await expect(group.locator("[data-account-row]")).toHaveCount(2);

  // Codex's page sends the browser back to this Mac, where the computer's
  // sign-in does not wait: the address the browser ends on is pasted back
  // here, and the allowance it reads there shows in its row.
  await recordOpens(app);
  await group.locator('[data-connect-provider="openai-codex"]').click();
  const codex = group.locator('[data-device-sign-in-provider="openai-codex"]');
  await codex.getByRole("button", { name: /^Browser login/ }).click();
  await codex.getByRole("button", { name: "Open the link", exact: true }).click();
  await expect.poll(() => opened(app)).toHaveLength(1);
  const [link = ""] = await opened(app);
  const endsOn = browserEndsOn(link, PASTED);
  expect(new URL(endsOn).hostname).toBe("localhost");
  await codex.getByLabel(`The address for ${PLACE.who}`).fill(endsOn);
  await codex.getByRole("button", { name: `Send to ${PLACE.who}`, exact: true }).click();
  await expect(group.locator("[data-account-row]")).toHaveCount(3);
  const codexRow = group.locator('[data-account-row]:has-text("Codex")');
  await expect(codexRow).toContainText(`${100 - CODEX_USED}%`);

  // Nothing the home keeps holds what was typed; the computer's own store does.
  const readable = JSON.stringify([
    await page.evaluate(() => window.infinitary.cards.list()),
    await page.evaluate(() => window.infinitary.devices.signIns()),
  ]);
  for (const typed of [KEY, PASTED, endsOn]) {
    expect(readable).not.toContain(typed);
    expect(savedText(app.userDataDir).filter(({ text }) => text.includes(typed))).toEqual([]);
  }
  expect(savedText(join(dataDir, "accounts")).some(({ text }) => text.includes(KEY))).toBe(true);
});

test("a computer signs in to Claude with the link opened here and the code it shows pasted back", async () => {
  const claude = scriptedClaude();
  // No login there until Claude Code signs in and keeps it in its saved passwords.
  const saved = savedPasswords(true, () => claude.seen.loggedIn);
  const { app, page, deviceId } = await homeAndComputer({
    claude: claude.options,
    keychain: saved.keychain,
  });
  await openIntelligence(page);
  const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
  await group.locator('[data-connect-provider="anthropic-claude"]').click();
  const aside = group.locator('[data-device-sign-in-provider="anthropic-claude"]');
  await expect(aside.getByRole("button", { name: "Open the link", exact: true })).toBeVisible();
  await aside.getByLabel(`The code for ${PLACE.who}`).fill(CLAUDE_CODE);
  await aside.getByRole("button", { name: `Send to ${PLACE.who}`, exact: true }).click();
  await expect(group.locator('[data-account-row]:has-text("Claude")')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, { type: "device_signed_in", deviceId, who: PLACE.who, provider: "Claude" }),
  ).toBeVisible();

  // Its client there took the code once, and opened no browser there.
  expect(claude.seen.pasted).toEqual([CLAUDE_CODE]);
  expect(claude.seen.browser).toEqual([NO_BROWSER]);
  // Nothing the home keeps holds the code.
  expect(savedText(app.userDataDir).filter(({ text }) => text.includes(CLAUDE_CODE))).toEqual([]);

  // The allowance it reads there, with its own login, shows in its row,
  // and nothing let macOS ask on that screen.
  await openIntelligence(page);
  const claudeRow = group.locator('[data-account-row]:has-text("Claude")');
  await expect(claudeRow).toHaveAttribute("data-row-kind", "ok");
  await expect(claudeRow).toContainText(`${100 - CLAUDE_USED}%`);
  expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);

  // Disconnect signs that computer out of the Claude login Firstmate made
  // there from the pasted code, and the feed says so.
  await claudeRow.getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  await expect(claudeRow).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, {
      type: "device_signed_out",
      deviceId,
      who: PLACE.who,
      provider: "Claude",
      login: "signed-out",
    }),
  ).toBeVisible();
  expect(claude.seen.loggedIn).toBe(false);
});

test("a computer's Claude row says why its allowance is not read there when macOS would have to ask", async () => {
  // A Claude login already there, adopted; macOS there would ask before Firstmate reads it.
  const claude = scriptedClaude(true);
  const saved = savedPasswords(false);
  const { page, deviceId } = await homeAndComputer({
    claude: claude.options,
    keychain: saved.keychain,
  });
  await openIntelligence(page);
  const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
  await group.locator('[data-connect-provider="anthropic-claude"]').click();
  const claudeRow = group.locator('[data-account-row]:has-text("Claude")');
  await expect(claudeRow).toHaveCount(1);

  // Never "reading" with no end: the row says why, and offers no Retry that
  // would have to ask on a screen nobody may be at: its one button is its menu.
  await expect(claudeRow).toHaveAttribute("data-row-kind", "unavailable");
  await expect(claudeRow.getByRole("button")).toHaveCount(1);
  await expect(claudeRow.getByRole("button", { name: /actions$/ })).toHaveCount(1);
  expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);

  // That login was there before Firstmate: Disconnect leaves it, and the feed says so.
  await claudeRow.getByRole("button", { name: /actions$/ }).click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  await expect(claudeRow).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, {
      type: "device_signed_out",
      deviceId,
      who: "Builder",
      provider: "Claude",
      login: "kept",
    }),
  ).toBeVisible();
  expect(claude.seen.loggedIn).toBe(true);
});

test("a computer already signed in to Claude uses that login, and asks for no code here", async () => {
  // Claude Code there is signed in, its login in that Mac's saved passwords alone.
  const claude = scriptedClaude(true);
  const saved = savedPasswords(false);
  const { page, deviceId } = await homeAndComputer({
    claude: claude.options,
    keychain: saved.keychain,
  });
  await openIntelligence(page);
  const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
  await group.locator('[data-connect-provider="anthropic-claude"]').click();
  await expect(group.locator('[data-account-row]:has-text("Claude")')).toHaveCount(1);
  await expect(group.locator('[data-device-sign-in-provider="anthropic-claude"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, { type: "device_signed_in", deviceId, who: "Builder", provider: "Claude" }),
  ).toBeVisible();

  // No sign-in ran there to replace the login, and macOS was never let ask there.
  expect(claude.seen.browser).toEqual([]);
  expect(claude.seen.pasted).toEqual([]);
  expect(saved.queries.length).toBeGreaterThan(0);
  expect(saved.queries.filter((query) => query.interactive === true)).toEqual([]);
});

test("a computer signs in to GitHub for its own clones and pushes from Settings -> Projects here", async () => {
  github = await startGitHubStub();
  const { app, page, deviceId, dataDir } = await homeAndComputer({ github });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();

  // This Mac's own GitHub sign-in is in Integrations (INF-775, the captain's q2),
  // so Projects points there; the computer's row is here, not signed in.
  await expect(page.locator("[data-forges]").locator('[data-forge-row="github.com"]')).toHaveCount(
    0,
  );
  await expect(page.locator("[data-integrations-pointer]")).toContainText(
    INTEGRATIONS_WORDS.pointer,
  );
  const row = page.locator(`[data-device-forge-row="${deviceId}"]`);
  await expect(row).toHaveAttribute("data-forge-state", "none");

  // GitHub's code to read, here; the computer finishes the sign-in itself.
  await row.getByRole("button", { name: "Sign in", exact: true }).click();
  const aside = page.locator('[data-device-sign-in-provider="github.com"]');
  await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
  // The same row 6 guardrail for the other caller: a code stays available on return.
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await expect(aside).toHaveCount(0);
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
  await expect(aside.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  github.device.approve(COMPUTER_GITHUB);
  await expect(row).toHaveAttribute("data-forge-state", "ok");
  await expect(row).toContainText(DEVICE_FORGE_ROLE);
  await expect(aside).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    feedLineOf(page, { type: "device_signed_in", deviceId, who: "Builder", provider: "GitHub" }),
  ).toBeVisible();

  // Its git answers GitHub with the computer's own sign-in, never the home's.
  const answer = (prompt: string) =>
    execFileSync("sh", [ASKPASS, prompt], { env: hostEnv(), encoding: "utf8" }).trim();
  expect(answer("Username for 'https://github.com':")).toBe("x-access-token");
  expect(answer("Password for 'https://x-access-token@github.com':")).toBe(COMPUTER_GITHUB);
  // Nothing the home keeps holds it; the computer's own store does.
  expect(savedText(app.userDataDir).filter(({ text }) => text.includes(COMPUTER_GITHUB))).toEqual(
    [],
  );
  expect(
    savedText(join(dataDir, "forges")).some(({ text }) => text.includes(COMPUTER_GITHUB)),
  ).toBe(true);

  // Signing it out from here deletes it there.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await row.getByRole("button", { name: "GitHub as Builder actions" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(row).toHaveAttribute("data-forge-state", "none");
  expect(savedText(dataDir).filter(({ text }) => text.includes(COMPUTER_GITHUB))).toEqual([]);
});

/** GitHub CLI on the computer, signed in to github.com with a sign-in of its own; it logs every call. */
function standInGitHubCli(): { path: string; calls: () => string[] } {
  const dir = scratchDir("infinitary-e2e-computer-gh-");
  const log = join(dir, "gh-calls.log");
  const path = join(dir, "gh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1 $2 $3 $4" = "auth token --hostname github.com" ]; then echo ${COMPUTER_GITHUB_CLI}; exit 0; fi\necho "no oauth token found for $4" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  return {
    path,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []),
  };
}

// INF-3145, the captain's user: registering a separate computer, its GitHub
// sign-in "doesn't have the recent change where it allows to sign with GH via
// already authenticated cli".
test("a computer signs in to GitHub through its own GitHub CLI from Settings -> Projects here", async () => {
  github = await startGitHubStub();
  const cli = standInGitHubCli();
  const { app, page, deviceId, dataDir } = await homeAndComputer({ github, githubCli: cli.path });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  const row = page.locator(`[data-device-forge-row="${deviceId}"]`);
  await expect(row).toHaveAttribute("data-forge-state", "none");

  // The code stays first; GitHub CLI's line sits under it, naming that
  // computer, and nothing asks GitHub CLI until the click.
  await row.getByRole("button", { name: "Sign in", exact: true }).click();
  const aside = page.locator('[data-device-sign-in-provider="github.com"]');
  await expect(aside.locator("[data-device-sign-in-code]")).toHaveText(STUB_USER_CODE);
  const line = page.locator(`[data-device-forge-cli="${deviceId}"]`);
  await expect(line).toContainText(forgeCliOffer(PLACE.where));
  expect(cli.calls()).toEqual([]);
  await heroShot(app.app, page, {
    region: line,
    anchors: [row, aside],
    name: "computer-github-cli-sign-in",
  });
  await line.getByRole("button", { name: FORGE_CLI_WORDS.use }).click();

  // The row says it signs in through GitHub CLI; the code is gone.
  await expect(row).toHaveAttribute("data-forge-state", "ok");
  await expect(row).toContainText(
    `${PLACE.label} · ${FORGE_CLI_WORDS.through} · ${DEVICE_FORGE_ROLE}`,
  );
  await expect(aside).toHaveCount(0);
  await expect(line).toHaveCount(0);
  await regionShot(row, test.info().outputPath("computer-github-cli-row.png"));
  expect(cli.calls()).toContain("auth token --hostname github.com");

  // Its git asks that computer's GitHub CLI each time; nobody keeps its sign-in.
  const answer = (prompt: string) =>
    execFileSync("sh", [ASKPASS, prompt], { env: hostEnv(), encoding: "utf8" }).trim();
  expect(answer("Password for 'https://x-access-token@github.com':")).toBe(COMPUTER_GITHUB_CLI);
  const file = readFileSync(join(dataDir, "forges", "github.com", "sign-in.json"), "utf8");
  expect(JSON.parse(file)).toMatchObject({ way: "cli", program: cli.path });
  expect(savedText(dataDir).filter(({ text }) => text.includes(COMPUTER_GITHUB_CLI))).toEqual([]);
  expect(
    savedText(app.userDataDir).filter(({ text }) => text.includes(COMPUTER_GITHUB_CLI)),
  ).toEqual([]);
});

test("a custom API added on a computer is kept there and its model can be placed", async () => {
  test.setTimeout(120_000);
  const { app, page, deviceId, dataDir } = await homeAndComputer();
  const port = app.mockProvider?.port;
  if (!port) throw new Error("The stand-in provider did not start.");
  const api = await startCustomApiFixture(port, undefined, {
    object: "list",
    data: [{ id: "operator-model", context_length: 8192, max_completion_tokens: 1024 }],
  });
  try {
    await openIntelligence(page);
    const group = page.locator(`[data-device-sign-ins="${deviceId}"]`);
    await group.locator("[data-connect-custom-api]").click();
    await expect(page.getByRole("dialog", { name: "Add a custom API as Builder" })).toBeVisible();
    const key = "sk-e2e-custom-there";
    await fillCustomApi(page, {
      name: "Studio models",
      address: api.baseUrl,
      network: "local",
      who: "Builder",
      key,
      pick: ["operator-model"],
    });
    expect(await saveCustomApi(page)).toBe("saved");
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.infinitary.devices
              .signIns()
              .then(
                (rows) =>
                  rows.find((row) => row.deviceId === id)?.signIns?.custom?.[0]?.accountId ?? "",
              ),
          deviceId,
        ),
      )
      .not.toBe("");
    const accountId = await page.evaluate(
      (id) =>
        window.infinitary.devices
          .signIns()
          .then(
            (rows) =>
              rows.find((row) => row.deviceId === id)?.signIns?.custom?.[0]?.accountId ?? "",
          ),
      deviceId,
    );
    const block = customApiBlock(page, accountId);
    await expect(block.block).toContainText("Ready");
    await expect(block.block).toContainText("operator-model");
    await expect(block.block.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    await expect(
      block.block.getByRole("button", { name: "Disconnect", exact: true }),
    ).toBeVisible();
    await expect(block.block.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
    await expect(block.firstmate("operator-model")).toHaveCount(0);

    const models = await openModelsBoard(page);
    const off = levelLane(models, "off");
    await expect(off.getByRole("button", { name: "operator-model", exact: true })).toBeVisible();
    await expect(off.locator("[data-model-row]").filter({ hasText: "Builder" })).toBeVisible();
    const panel = await openModelPanel(page, off, "operator-model");
    await setLevelInPanel(panel, "operator-model", "medium", true);
    await closeModelPanel(models);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.infinitary.models.slots().then((board) => {
            const row = [...board.models, ...board.byName].find(
              (model) => model.id === "operator-model",
            );
            return row ? `${row.place ?? ""}:${row.slots.join(",")}` : "";
          }),
        ),
      )
      .toBe("Builder:medium");
    const placed = await openModelsBoard(page);
    await expect(
      levelLane(placed, "medium").getByRole("button", { name: "operator-model", exact: true }),
    ).toBeVisible();

    const slots = await page.evaluate(() => window.infinitary.models.slots());
    expect(
      slots.models.find((model) => model.id === "operator-model" && model.place === "Builder")
        ?.slots,
    ).toEqual(["medium"]);
    // The key went to the computer once. This Mac keeps no copy; the computer's store does.
    expect(
      JSON.stringify(await page.evaluate(() => window.infinitary.devices.signIns())),
    ).not.toContain(key);
    expect(savedText(app.userDataDir).some(({ text }) => text.includes(key))).toBe(false);
    expect(savedText(dataDir).some(({ text }) => text.includes(key))).toBe(true);
  } finally {
    await api.close();
  }
});
