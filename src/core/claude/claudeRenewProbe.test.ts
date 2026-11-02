import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { NO_BROWSER, resolveClaudeExecutable, runClaude } from "./claudeCli";
import { CLAUDE_RENEW_COMMANDS, credentialMarker, readClaudeStore } from "./claudeQuota";

/**
 * Ordinary runs exercise the probe's isolation through a recording client.
 * The installed-client legs are opt-in, on Linux's file-backed store only:
 * INFINITARY_CLAUDE_RENEW_PROBE=1, optionally with INFINITARY_CLAUDE_RENEW_PROBE_DIR
 * naming a THROWAWAY account's config root. Never copy the captain's login:
 * refresh tokens are single use. No probe starts a sign-in or model session.
 *
 * Production runClaude deliberately ignores configDir for store selection.
 * The probe must override its child environment explicitly, and observe the
 * same file store. A directory check cannot prove anything about a Keychain
 * credential, so macOS real-client runs are refused, not reported as passes.
 * See docs/claude-renew-probe.md.
 */
const probeRequested = process.env.INFINITARY_CLAUDE_RENEW_PROBE === "1";
const probeDir = process.env.INFINITARY_CLAUDE_RENEW_PROBE_DIR?.trim();
/** Long enough for a cold start of a 300MB single-file client. */
const PROBE_TIMEOUT_MS = 90_000;

afterEach(() => vi.unstubAllEnvs());

/** One identity for the child's store and every assertion about that store. */
function isolatedProbe(accountDir?: string) {
  const home = scratchDir("infinitary-claude-renew-home-");
  const configDir = accountDir ?? join(home, ".claude");
  const temp = join(home, "tmp");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(temp);
  const credentials = join(configDir, ".credentials.json");
  const run = (args: readonly string[]) =>
    runClaude([...args], configDir, {
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        HOME: home,
        CFFIXED_USER_HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        TMPDIR: temp,
        BROWSER: NO_BROWSER,
        DISABLE_AUTOUPDATER: "1",
      },
    });
  const marker = async () =>
    credentialMarker(
      await readClaudeStore(configDir, { bypassCache: true }).then((read) =>
        read.state === "present" ? read.auth : undefined,
      ),
    );
  const assertEmpty = async () => {
    // Check the actual store, not an unrelated scratch directory. On Linux
    // this is the client's credential backend; status also proves signed out.
    expect(existsSync(credentials), "the client wrote a credential into its store").toBe(false);
    const status = await run(["auth", "status", "--json"]);
    expect(JSON.parse(status.stdout).loggedIn).toBe(false);
    expect(existsSync(credentials), "the status command wrote a credential").toBe(false);
  };
  return { home, configDir, credentials, run, marker, assertEmpty };
}

/** Fail closed on missing input, the default login, or a credential-file alias. */
function throwawayAccountDir(input: string): string {
  if (!isAbsolute(input)) throw new Error("The throwaway config root must be an absolute path.");
  const dir = realpathSync(input);
  const defaultDir = resolve(homedir(), ".claude");
  if (dir === defaultDir || (existsSync(defaultDir) && dir === realpathSync(defaultDir))) {
    throw new Error("The account probe must not use the machine's default Claude login.");
  }
  const stat = lstatSync(join(dir, ".credentials.json"));
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error("The throwaway credential must be a regular file, not a link.");
  }
  return dir;
}

async function checkLadder(probe: ReturnType<typeof isolatedProbe>) {
  for (const args of CLAUDE_RENEW_COMMANDS) {
    // A command waiting for a terminal rejects at the bounded spawn timeout.
    const result = await probe.run(args);
    expect(result.code, `${args.join(" ")} did not exit`).not.toBeNull();
    expect(
      `${result.stdout}${result.stderr}`.toLowerCase(),
      `${args.join(" ")} is not a known command`,
    ).not.toContain("unknown command");
  }
}

async function measureRenewal(probe: ReturnType<typeof isolatedProbe>) {
  let marker = await probe.marker();
  expect(marker, "the probe directory holds no credential to renew").toBeDefined();
  const findings: { command: string; changed: boolean }[] = [];
  for (const args of CLAUDE_RENEW_COMMANDS) {
    await probe.run(args);
    const next = await probe.marker();
    // Deleting or corrupting the credential is not renewal.
    expect(next, "the client lost its credential rather than renewing it").toBeDefined();
    findings.push({ command: args.join(" "), changed: next !== marker });
    marker = next;
  }
  return findings;
}

describe.skipIf(!probeRequested)("the installed client's delegated-renewal ladder (opt-in)", () => {
  beforeAll(() => {
    if (process.platform !== "linux") {
      throw new Error("Run the renewal probe on disposable Linux with a file-backed Claude store.");
    }
    if (!resolveClaudeExecutable())
      throw new Error("The requested Claude client is not installed.");
  });

  it("every ladder command is real, non-interactive and harmless against an empty store", async () => {
    const probe = isolatedProbe();
    await probe.assertEmpty();
    await checkLadder(probe);
    await probe.assertEmpty();
  }, 240_000);

  it.skipIf(!probeDir)(
    "records which command renews a throwaway expired session",
    async () => {
      const probe = isolatedProbe(throwawayAccountDir(probeDir as string));
      const findings = await measureRenewal(probe);
      // Names and booleans only: no token, marker or store contents. The test
      // runner's output is the record; no unowned file is left in shared temp.
      console.log(JSON.stringify(findings));
      expect(findings.some((finding) => finding.changed)).toBe(true);
    },
    240_000,
  );
});

/** A real subprocess that uses the store selected by the environment it received. */
function recordingClient(effect: "none" | "write" | "delete" = "none") {
  const root = scratchDir("infinitary-renew-recording-");
  const log = join(root, "calls.jsonl");
  const executable = join(root, "claude.cjs");
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude');
const credentials = path.join(dir, '.credentials.json');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, dir, home: process.env.HOME,
  fixedHome: process.env.CFFIXED_USER_HOME, ambientKey: !!process.env.ANTHROPIC_API_KEY }) + '\\n');
if (args[0] === 'doctor') {
  if (${JSON.stringify(effect)} === 'write') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-renewed' } }));
  }
  if (${JSON.stringify(effect)} === 'delete') fs.rmSync(credentials, { force: true });
}
console.log(JSON.stringify({ loggedIn: fs.existsSync(credentials) }));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("INFINITARY_CLAUDE_CLI", executable);
  return () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
}

function syntheticAccount() {
  const home = scratchDir("infinitary-renew-outer-home-");
  const defaultDir = join(home, ".claude");
  mkdirSync(defaultDir);
  writeFileSync(join(defaultDir, ".credentials.json"), "do not read or change this login");
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", defaultDir);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-ambient-key");
  const account = scratchDir("infinitary-renew-account-");
  writeFileSync(
    join(account, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-expired", expiresAt: 1 } }),
  );
  return { account, defaultDir };
}

describe("the renewal probe's store boundary (recording client only)", () => {
  it("runs every command in the checked store, never the ambient login", async () => {
    const { defaultDir } = syntheticAccount();
    const calls = recordingClient();
    const probe = isolatedProbe();
    await probe.assertEmpty();
    await checkLadder(probe);
    await probe.assertEmpty();
    expect(calls().map((call) => call.args)).toEqual([
      ["auth", "status", "--json"],
      ...CLAUDE_RENEW_COMMANDS,
      ["auth", "status", "--json"],
    ]);
    for (const call of calls()) {
      expect(call).toMatchObject({
        dir: probe.configDir,
        home: probe.home,
        fixedHome: probe.home,
        ambientKey: false,
      });
    }
    expect(readFileSync(join(defaultDir, ".credentials.json"), "utf8")).toBe(
      "do not read or change this login",
    );
  });

  it("catches a credential written by the child into its actual store", async () => {
    recordingClient("write");
    const probe = isolatedProbe();
    await checkLadder(probe);
    await expect(probe.assertEmpty()).rejects.toThrow("the client wrote a credential");
  });

  it("observes renewal in the selected account store, not the default login", async () => {
    const { account, defaultDir } = syntheticAccount();
    const calls = recordingClient("write");
    const probe = isolatedProbe(throwawayAccountDir(account));
    const findings = await measureRenewal(probe);
    expect(findings).toEqual([
      { command: "auth status --json", changed: false },
      { command: "doctor", changed: true },
    ]);
    expect(calls().every((call) => call.dir === realpathSync(account))).toBe(true);
    expect(readFileSync(join(defaultDir, ".credentials.json"), "utf8")).toBe(
      "do not read or change this login",
    );
  });

  it("does not count a deleted credential as renewal", async () => {
    const { account } = syntheticAccount();
    recordingClient("delete");
    await expect(measureRenewal(isolatedProbe(throwawayAccountDir(account)))).rejects.toThrow(
      "the client lost its credential",
    );
  });

  it("refuses the default login, its aliases and relative paths before running a client", () => {
    const { defaultDir } = syntheticAccount();
    const alias = join(scratchDir("infinitary-renew-alias-"), "config");
    symlinkSync(defaultDir, alias);
    expect(() => throwawayAccountDir(defaultDir)).toThrow("machine's default Claude login");
    expect(() => throwawayAccountDir(alias)).toThrow("machine's default Claude login");
    expect(() => throwawayAccountDir(".claude")).toThrow("absolute path");
  });

  it.each(["symbolic", "hard"])("refuses a %s link to another store's credential", (kind) => {
    const { defaultDir } = syntheticAccount();
    const dir = scratchDir("infinitary-renew-linked-credential-");
    const link = kind === "symbolic" ? symlinkSync : linkSync;
    link(join(defaultDir, ".credentials.json"), join(dir, ".credentials.json"));
    expect(() => throwawayAccountDir(dir)).toThrow("not a link");
  });
});
