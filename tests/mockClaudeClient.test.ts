import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeStore } from "../src/core/claude/claudeQuota";
import { absentKeychain } from "../src/core/host";
import {
  claudeDefaultStore,
  MOCK_CLAUDE_API_KEY,
  MOCK_CLAUDE_OAUTH_TOKEN,
  mockClaudeKeychainLookups,
  signedInClaudeHome,
  writeMockClaudeClient,
} from "./e2e/mockClaudeClient";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The e2e Claude stub's dispatch, driven the way the SDK drives it: an
 * executable, its arguments, its environment and its stdin. Turn mode hands
 * a session that runs turns to a client (here a recorder standing in for the
 * SDK's co-released one) inside a box - its config and temp dirs in the
 * throwaway HOME, a dummy key, the mock provider's address and a Keychain
 * shim first on its path - and leaves every other command stubbed.
 */

type Run = { code: number | null; stdout: string; pid: number | undefined };

/** Run the stub as the SDK would: piped stdio, the given env, one stdin payload. */
function runStub(stub: string, args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(stub, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, pid: child.pid }));
    // A child that exits without reading its stdin (the Keychain shim) can
    // close the pipe before this write lands; its exit code is the answer.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(stdin);
  });
}

type Recorded = {
  pid: number;
  args: string[];
  env: Record<string, string | undefined>;
  stdin: string;
};

/** A client that records what it was handed and exits 7, so the exit is seen passing through. */
function writeRecordingClient(dir: string): { client: string; record: string } {
  const record = join(dir, "client-record.json");
  const client = join(dir, "recording-client.mjs");
  writeFileSync(
    client,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: process.env, stdin }));
  process.exit(7);
});
`,
    { mode: 0o755 },
  );
  return { client, record };
}

const SESSION_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  "--model",
  "claude-haiku-4-5",
  "--session-id=0b0e4a8e-6f2d-4d57-9a8e-3d0c2f1f7a11",
];

function setup(
  turns: { credential?: "api-key" | "subscription"; maxRetries?: number; baseUrl?: string } = {},
  prefix = "infinitary-claude-stub-",
) {
  const dir = scratchDir(`${prefix}test-`);
  const home = scratchDir(`${prefix}home-`);
  const { client, record } = writeRecordingClient(dir);
  const listing = join(dir, "listing.json");
  writeFileSync(listing, JSON.stringify([{ value: "claude-haiku-4-5", displayName: "Haiku" }]));
  const stub = writeMockClaudeClient(home, {
    listModelsFile: listing,
    turns: { baseUrl: "http://127.0.0.1:9", client, ...turns },
  });
  // What the app hands the client (claudeEnvFor): its HOME, no config dir,
  // and - should one ever leak through - a credential that is not ours.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ANTHROPIC_AUTH_TOKEN: "not-ours",
    CLAUDE_CODE_OAUTH_TOKEN: "not-ours",
  };
  const recorded = (): Recorded | undefined =>
    existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as Recorded) : undefined;
  return { dir, home, stub, env, recorded };
}

/** INF-2394 measure 1: the one seed must satisfy both the client and the product's real store reader. */
describe("a signed-in Claude home", () => {
  it("is signed in through both consumers, with private files and no real Keychain", async () => {
    const home = scratchDir("infinitary-claude-home-");
    const stub = writeMockClaudeClient(join(home, "bin"));
    signedInClaudeHome(home);
    const status = await runStub(stub, ["auth", "status", "--json"], {
      HOME: home,
      PATH: process.env.PATH,
    });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ loggedIn: true });
    const read = await readClaudeStore(claudeDefaultStore(home), {
      keychain: absentKeychain,
      env: { HOME: home },
    });
    expect(read).toMatchObject({
      state: "present",
      auth: { accessToken: "fake-access", expiresAt: 4_000_000_000_000 },
    });
    // The quota reader deliberately does not expose the refresh token; the client owns it.
    expect(
      JSON.parse(readFileSync(join(claudeDefaultStore(home), ".credentials.json"), "utf8")),
    ).toMatchObject({ claudeAiOauth: { refreshToken: "fake-refresh" } });
    for (const name of ["stub-credential", ".credentials.json"])
      expect(statSync(join(claudeDefaultStore(home), name)).mode & 0o777).toBe(0o600);
  });

  it("keeps a journey's renewed credential on a seat relaunch", async () => {
    const home = scratchDir("infinitary-claude-home-");
    signedInClaudeHome(home, {
      credentials: {
        accessToken: "renewed-token",
        refreshToken: "renewed-refresh",
        expiresAt: 4_000_000_000_000,
        refreshTokenExpiresAt: 4_000_000_000_000,
      },
    });
    signedInClaudeHome(home, { preserveCredentials: true });
    const read = await readClaudeStore(claudeDefaultStore(home), {
      keychain: absentKeychain,
      env: { HOME: home },
    });
    expect(read).toMatchObject({ state: "present", auth: { accessToken: "renewed-token" } });
  });
});

describe("the e2e Claude stub in turn mode", () => {
  it("shares only executable preparation across concurrent HOME-local boxes", async () => {
    const a = setup();
    const stamp = statSync(a.stub).mtimeMs;
    const shim = join(dirname(a.stub), "keychain-shim", "security");
    const shimStamp = statSync(shim).mtimeMs;
    const b = setup({ credential: "subscription", maxRetries: 0, baseUrl: "http://127.0.0.1:19" });
    expect(b.stub).toBe(a.stub);
    expect(statSync(b.stub).mtimeMs).toBe(stamp);
    expect(statSync(shim).mtimeMs).toBe(shimStamp);
    const runs = await Promise.all([
      runStub(a.stub, SESSION_ARGS, a.env, "first-home"),
      runStub(b.stub, SESSION_ARGS, b.env, "second-home"),
    ]);
    expect(runs.map((run) => run.code)).toEqual([7, 7]);
    expect(a.recorded()).toMatchObject({
      stdin: "first-home",
      env: {
        HOME: a.home,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        ANTHROPIC_API_KEY: MOCK_CLAUDE_API_KEY,
      },
    });
    expect(b.recorded()).toMatchObject({
      stdin: "second-home",
      env: {
        HOME: b.home,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:19",
        CLAUDE_CODE_OAUTH_TOKEN: MOCK_CLAUDE_OAUTH_TOKEN,
        CLAUDE_CODE_MAX_RETRIES: "0",
      },
    });
    expect(b.recorded()?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(a.recorded()?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(a.recorded()?.env.PATH).toBe(b.recorded()?.env.PATH);
    for (const [box, name] of [
      [a, "first"],
      [b, "second"],
    ] as const) {
      expect(box.recorded()?.env.PATH?.split(delimiter)[0]).toBe(
        join(dirname(box.stub), "keychain-shim"),
      );
      expect(
        (await runStub("/bin/sh", ["-c", `security ${name}-lookup`], box.recorded()?.env ?? {}))
          .code,
      ).toBe(44);
      expect(mockClaudeKeychainLookups(box.home)).toEqual([`${name}-lookup`]);
    }
    // Removing one test's HOME cannot delete executable preparation or another box's state.
    rmSync(a.home, { recursive: true, force: true });
    expect((await runStub(b.stub, SESSION_ARGS, b.env)).code).toBe(7);
    expect(mockClaudeKeychainLookups(b.home)).toEqual(["second-lookup"]);
    expect(statSync(b.stub).mtimeMs).toBe(stamp);
    expect(statSync(shim).mtimeMs).toBe(shimStamp);
  });

  it("refuses an unconfigured HOME rather than borrowing another test's options", async () => {
    const { stub, env, recorded } = setup();
    const other = scratchDir("infinitary-claude-unconfigured-home-");
    expect((await runStub(stub, SESSION_ARGS, { ...env, HOME: other })).code).toBe(2);
    expect(recorded()).toBeUndefined();
    expect(mockClaudeKeychainLookups(other)).toEqual([]);
  });

  it("hands a session that runs turns to the client, boxed in", async () => {
    const { home, stub, env, recorded } = setup();
    const run = await runStub(stub, SESSION_ARGS, env, '{"type":"user"}\n');

    expect(run.code, "the client's exit passes through").toBe(7);
    const handed = recorded();
    expect(handed?.args).toEqual(SESSION_ARGS);
    expect(handed?.stdin).toBe('{"type":"user"}\n');
    if (process.platform !== "win32") {
      expect(handed?.pid, "the client replaces the launcher, with no Node supervisor").toBe(
        run.pid,
      );
    }
    expect(handed?.env).toMatchObject({
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TMPDIR: join(home, ".claude-client-tmp"),
      ANTHROPIC_API_KEY: MOCK_CLAUDE_API_KEY,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    expect(handed?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(handed?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    // The first `security` on the client's path records and answers "not
    // found"; nothing reaches the machine's Keychain.
    const path = handed?.env.PATH ?? "";
    expect(path.split(delimiter)[0]).toBe(join(dirname(stub), "keychain-shim"));
    const lookup = await runStub(
      "/bin/sh",
      ["-c", 'security find-generic-password -w -s "Claude Code-credentials"'],
      { ...handed?.env, PATH: path },
    );
    expect(lookup.code).toBe(44);
    expect(mockClaudeKeychainLookups(home)).toEqual([
      "find-generic-password -w -s Claude Code-credentials",
    ]);
  });

  it("keeps quoted paths and arguments literal when launching the client", async () => {
    const { home, stub, env, recorded } = setup({}, "infinitary-claude- ' $literal- ");
    const args = [...SESSION_ARGS, "--literal=it's $HOME; not a command"];
    expect((await runStub(stub, args, env)).code).toBe(7);
    expect(recorded()?.args).toEqual(args);
    expect(recorded()?.env.HOME).toBe(env.HOME);
    expect(recorded()?.env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME as string, ".claude"));
    expect(recorded()?.env.PATH?.split(delimiter)[0]).toBe(join(dirname(stub), "keychain-shim"));
    const lookup = await runStub("/bin/sh", ["-c", "security literal-lookup"], {
      ...recorded()?.env,
    });
    expect(lookup.code).toBe(44);
    expect(mockClaudeKeychainLookups(home)).toEqual(["literal-lookup"]);
  });

  it("refuses a turn without a scratch HOME before starting the client", async () => {
    const { stub, recorded } = setup();
    expect((await runStub(stub, SESSION_ARGS, { PATH: process.env.PATH ?? "" })).code).toBe(2);
    expect(recorded()).toBeUndefined();
  });

  it("boxes a subscription-shaped client with a dummy token and no key", async () => {
    const { stub, env, recorded } = setup({ credential: "subscription", maxRetries: 0 });
    expect((await runStub(stub, SESSION_ARGS, env)).code).toBe(7);
    const handed = recorded();
    expect(handed?.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: MOCK_CLAUDE_OAUTH_TOKEN,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      CLAUDE_CODE_MAX_RETRIES: "0",
    });
    expect(handed?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(handed?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("runs a resumed session through the client too", async () => {
    const { stub, env, recorded } = setup();
    const args = ["--input-format", "stream-json", "--resume=0b0e4a8e"];
    expect((await runStub(stub, args, env)).code).toBe(7);
    expect(recorded()?.args).toEqual(args);
  });

  it("answers the catalog read itself: it names no session and no model", async () => {
    const { stub, env, recorded } = setup();
    const initialize = `${JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "initialize" },
    })}\n`;
    const run = await runStub(
      stub,
      ["--output-format", "stream-json", "--input-format", "stream-json"],
      env,
      initialize,
    );
    expect(recorded(), "the client never ran").toBeUndefined();
    const answer = JSON.parse(run.stdout.trim());
    expect(answer.response.request_id).toBe("r1");
    expect(answer.response.response.models).toEqual([
      { value: "claude-haiku-4-5", displayName: "Haiku" },
    ]);
  });

  it("keeps the version and sign-in commands stubbed", async () => {
    const { stub, env, recorded } = setup();
    expect((await runStub(stub, ["--version"], env)).stdout).toBe("99.0.0 (Claude Code)\n");
    const status = await runStub(stub, ["auth", "status", "--json"], env);
    expect(JSON.parse(status.stdout)).toMatchObject({ loggedIn: false });
    expect(recorded()).toBeUndefined();
  });
});

describe("the e2e Claude stub without turn mode", () => {
  it("never starts a client for a session", async () => {
    const dir = scratchDir("infinitary-claude-stub-test-");
    const home = scratchDir("infinitary-claude-stub-home-");
    const stub = writeMockClaudeClient(dir);
    const run = await runStub(stub, SESSION_ARGS, { PATH: process.env.PATH ?? "", HOME: home });
    // Today's stub: a session is not answered, it reads as a signed-out status.
    expect(JSON.parse(run.stdout)).toMatchObject({ loggedIn: false });
    expect(existsSync(join(dir, "keychain-shim"))).toBe(false);
  });
});
