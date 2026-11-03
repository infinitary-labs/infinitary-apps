import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratchDirs";

/**
 * @journey-area src/core/claude/
 *
 * A stand-in for Claude's own client, for e2e. It speaks the three commands
 * Infinitary drives - `--version`, `auth login --claudeai` and `auth status
 * --json` - and, when a spec names a listing, the SDK's `initialize`
 * handshake that carries the account's model list (the runtime catalog
 * read, docs/model-lists.md) - against
 * the machine's default store (`$HOME/.claude` when CLAUDE_CONFIG_DIR is
 * unset, matching CD-1=B production), so the app exercises its real spawn
 * path, its real environment scoping, and its real status parsing without a
 * subscription, a browser, or a person.
 *
 * Nothing here signs anybody in: the "credential" is the word `stub`.
 *
 * Turn mode (`turns`): a session that runs turns is handed to the SDK's
 * own co-released client from node_modules - never the client the machine
 * has installed - so a Claude crewmate's turn runs the real stream-json and
 * in-process tool protocol at the version the SDK ships with. That client
 * is boxed in: its config dir and temp dir live in the run's throwaway
 * HOME, it holds a dummy key and talks only to the e2e mock provider, and
 * the one Keychain tool on its path is a shim that records the lookup and
 * answers "not found". A set CLAUDE_CONFIG_DIR already suffixes the
 * Keychain service name (docs/claude-client.md), so the machine's
 * login is out of reach twice over; the shim's record is how a spec proves
 * it. `--version`, `auth *` and the model-list handshake stay stubbed.
 */

export type MockClaudeClientOptions = {
  /** The identity the stub reports once a store holds its marker. */
  email?: string;
  plan?: string;
  /**
   * What `--version` prints. The default is far above any floor the SDK
   * could name, so a stub never reads as an outdated client; a spec that
   * wants the outdated path names an old one.
   */
  version?: string;
  /**
   * The model rows the SDK's `initialize` answer carries (`supportedModels`),
   * read from this file on every run so a spec can change it between
   * launches: a JSON array of `{ value, displayName }`. Anything that is not
   * one is a failed read. Absent, an SDK session is not answered at all.
   */
  listModelsFile?: string;
  /** Hold the model read open this long without answering. */
  listModelsHangMs?: number;
  /** Run a turn session on a real client against the mock provider (turn mode, above). */
  turns?: MockClaudeTurns;
};

export type MockClaudeTurns = {
  /** The mock provider's origin, the client's ANTHROPIC_BASE_URL. */
  baseUrl: string;
  /** The client to hand a turn session to; the SDK's co-released one by default. */
  client?: string;
  /**
   * What the boxed client signs in with: a dummy API key (the default), or
   * a dummy subscription token, with which the client runs the way a
   * person's Claude login does - it reads the plan-window headers a reply
   * carries and pushes its rate-limit readings, which an API key never
   * sees. Either one only ever reaches `baseUrl`.
   */
  credential?: "api-key" | "subscription";
  /** The client's own retries of a failed request; its default when absent. */
  maxRetries?: number;
};

/** The dummy key a turn-mode client holds; a request carrying any other credential is not ours. */
export const MOCK_CLAUDE_API_KEY = "sk-ant-e2e-mock-client-not-a-real-key";

/** The dummy subscription token a turn-mode client holds with `credential: "subscription"`. */
export const MOCK_CLAUDE_OAUTH_TOKEN = "sk-ant-oat01-e2e-mock-client-not-a-real-token";

/**
 * The SDK's own client binary, found the way the SDK finds it: the
 * platform package beside the SDK in node_modules. The app never runs this
 * copy (docs/claude-client.md); only the e2e stub does.
 */
export function sdkBundledClaudeClient(): string {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const suffix = process.platform === "win32" ? ".exe" : "";
  return createRequire(sdk).resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${suffix}`,
  );
}

/** Where the Keychain shim records each lookup a turn-mode client made. */
const STATE_DIR = ".infinitary-claude-stub";

function keychainLog(home: string): string {
  return join(home, STATE_DIR, "keychain-lookups.log");
}

/**
 * Every Keychain lookup the turn-mode client made from the scratch
 * `home`, one argument line each (`find-generic-password -a ... -s <service>`).
 */
export function mockClaudeKeychainLookups(home: string): string[] {
  const log = keychainLog(home);
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

/**
 * The Keychain shim a turn-mode client finds first on its path: it records
 * its arguments and answers the way `security` does for an item that is
 * not there (exit 44), so no lookup ever reaches the machine's Keychain.
 */
function writeKeychainShim(dir: string): string {
  const shimDir = join(dir, "keychain-shim");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "security");
  writeFileSync(
    shim,
    `#!/bin/sh
# Refuse a missing destination; never fall through to the machine's tool.
[ -n "$INFINITARY_MOCK_CLAUDE_KEYCHAIN_LOG" ] || exit 2
printf '%s\\n' "$*" >> "$INFINITARY_MOCK_CLAUDE_KEYCHAIN_LOG" || exit 2
exit 44
`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

/** The default Claude config root under a throwaway HOME. */
export function claudeDefaultStore(homeDir: string): string {
  return join(homeDir, ".claude");
}

/** Quote one literal for the POSIX launcher's environment and paths. */
function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes a stub and returns its path for INFINITARY_CLAUDE_CLI. In turn mode,
 * `dir` must be the child's scratch HOME: only its private configuration is
 * written there; immutable executables are prepared once per worker process.
 * Auth/catalog-only stubs keep their standalone output-directory interface.
 */
export function writeMockClaudeClient(dir: string, options: MockClaudeClientOptions = {}): string {
  const settings = {
    email: options.email ?? "kun@example.com",
    plan: options.plan ?? "max",
    version: options.version ?? "99.0.0",
    listing: options.listModelsFile ?? null,
    hangMs: options.listModelsHangMs ?? 0,
  };
  if (!options.turns) {
    return writeClientScript(
      dir,
      `const { email, plan, version, listing, hangMs, turns } = ${JSON.stringify({ ...settings, turns: null })};`,
    );
  }
  const prepared = boxedExecutables();
  const turns = {
    baseUrl: options.turns.baseUrl,
    client: options.turns.client ?? sdkBundledClaudeClient(),
    shimDir: prepared.shimDir,
    credential:
      options.turns.credential === "subscription"
        ? { CLAUDE_CODE_OAUTH_TOKEN: MOCK_CLAUDE_OAUTH_TOKEN }
        : { ANTHROPIC_API_KEY: MOCK_CLAUDE_API_KEY },
    retries:
      options.turns.maxRetries === undefined
        ? {}
        : { CLAUDE_CODE_MAX_RETRIES: String(options.turns.maxRetries) },
  };
  const state = join(dir, STATE_DIR);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "options.json"), JSON.stringify({ ...settings, turns }), {
    mode: 0o600,
  });
  const shellSettings = {
    mock_version: settings.version,
    mock_client: turns.client,
    mock_base_url: turns.baseUrl,
    mock_credential: options.turns.credential ?? "api-key",
    mock_retries: options.turns.maxRetries === undefined ? "" : String(options.turns.maxRetries),
  };
  writeFileSync(
    join(state, "turn-env.sh"),
    Object.entries(shellSettings)
      .map(([name, value]) => `${name}=${shellLiteral(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  return prepared.launcher;
}

function writeClientScript(dir: string, initialization: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claude-stub.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

${initialization}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(version + " (Claude Code)" + "\\n");
  process.exit(0);
}
// Every session that runs turns names what it runs: a session (minted or
// resumed) or a model. The catalog read is the one that names neither - it
// asks the client which models exist - so it stays stubbed.
const runsTurns =
  args.includes("--input-format") &&
  args.some((arg) => arg.startsWith("--session-id=") || arg.startsWith("--resume=") || arg === "--model");
if (turns !== null && runsTurns) {
  const home = process.env.HOME;
  if (!home) {
    process.stderr.write("no HOME\\n");
    process.exit(2);
  }
  const configDir = join(home, ".claude");
  const tmp = join(home, ".claude-client-tmp");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true });
  const env = { ...process.env };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"]) {
    delete env[name];
  }
  Object.assign(env, turns.credential, turns.retries, {
    CLAUDE_CONFIG_DIR: configDir,
    TMPDIR: tmp,
    ANTHROPIC_BASE_URL: turns.baseUrl,
    INFINITARY_MOCK_CLAUDE_KEYCHAIN_LOG: join(home, ${JSON.stringify(STATE_DIR)}, "keychain-lookups.log"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    PATH: turns.shimDir + delimiter + (env.PATH ?? ""),
  });
  const client = spawn(turns.client, args, { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => client.kill(signal));
  }
  client.on("error", (error) => {
    process.stderr.write(String(error) + "\\n");
    process.exit(1);
  });
  client.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (listing !== null && args.includes("--input-format")) {
  // The SDK's stream-json session: answer its initialize request with the
  // listing, the way the real client reports supportedModels(), and nothing
  // else - no turn ever starts.
  if (hangMs > 0) {
    setTimeout(() => process.exit(0), hangMs);
  } else {
    let rows;
    try {
      rows = JSON.parse(readFileSync(listing, "utf8"));
      if (!Array.isArray(rows)) throw new Error("not a listing");
    } catch {
      process.stderr.write("Authentication required\\n");
      process.exit(1);
    }
    const lines = createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
      process.stdout.write(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: { commands: [], agents: [], models: rows, account: {} },
          },
        }) + "\\n",
      );
    });
    lines.on("close", () => process.exit(0));
  }
} else {
const home = process.env.HOME;
if (!home) {
  process.stderr.write("no HOME\\n");
  process.exit(2);
}
const dir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
const marker = join(dir, "stub-credential");

if (args[0] === "auth" && args[1] === "login") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The real client prints where it sent the user, then completes over a
  // loopback callback. The stub prints the same shape and completes at once.
  process.stdout.write("Opening browser to sign in...\\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?stub=1\\n");
  writeFileSync(marker, "stub", { mode: 0o600 });
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "logout") {
  rmSync(marker, { force: true });
  process.exit(0);
}

const loggedIn = existsSync(marker);
process.stdout.write(
  JSON.stringify(
    loggedIn
      ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: email, subscriptionType: plan }
      : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
  ) + "\\n",
);
process.exit(loggedIn ? 0 : 1);
}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

type BoxedExecutables = { launcher: string; shimDir: string };
const BOXED_KEY = Symbol.for("infinitary.tests.boxedClaudeExecutables");
const boxedHolder = globalThis as { [BOXED_KEY]?: BoxedExecutables };

function boxedExecutables(): BoxedExecutables {
  const cached = boxedHolder[BOXED_KEY];
  if (cached) return cached;
  // No mutable client state is shared. Isolated Vitest workers finish one
  // integration file per process; scratchDir removes preparation after that
  // file (or at Playwright worker exit). Keep the existing cleanup and leak gate.
  const dir = scratchDir("infinitary-claude-executables-");
  const shimDir = writeKeychainShim(dir);
  const path = writeClientScript(
    dir,
    `
const home = process.env.HOME;
if (!home) { process.stderr.write("no HOME\\n"); process.exit(2); }
let settings;
try { settings = JSON.parse(readFileSync(join(home, ${JSON.stringify(STATE_DIR)}, "options.json"), "utf8")); }
catch { process.stderr.write("unconfigured HOME\\n"); process.exit(2); }
const { email, plan, version, listing, hangMs, turns } = settings;
`,
  );
  const launcher = process.platform === "win32" ? path : join(dir, "claude-stub");
  if (process.platform !== "win32") {
    // Exec retains the actual client's stdin, stdout and signal/exit boundary,
    // without paying for a second Node runtime on every real turn.
    writeFileSync(
      launcher,
      `#!/bin/sh
if [ -z "$HOME" ] || [ ! -f "$HOME/${STATE_DIR}/turn-env.sh" ]; then
  printf 'unconfigured HOME\\n' >&2
  exit 2
fi
. "$HOME/${STATE_DIR}/turn-env.sh"
if [ "$1" = "--version" ]; then
  printf '%s (Claude Code)\\n' "$mock_version"
  exit 0
fi
input=0
turn=0
for arg in "$@"; do
  case "$arg" in
    --input-format) input=1 ;;
    --session-id=*|--resume=*|--model) turn=1 ;;
  esac
done
if [ "$input" = 1 ] && [ "$turn" = 1 ]; then
  export CLAUDE_CONFIG_DIR="$HOME/.claude"
  export TMPDIR="$HOME/.claude-client-tmp"
  mkdir -p "$CLAUDE_CONFIG_DIR" "$TMPDIR" || exit 2
  chmod 700 "$CLAUDE_CONFIG_DIR" || exit 2
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  if [ "$mock_credential" = subscription ]; then
    export CLAUDE_CODE_OAUTH_TOKEN=${shellLiteral(MOCK_CLAUDE_OAUTH_TOKEN)}
  else
    export ANTHROPIC_API_KEY=${shellLiteral(MOCK_CLAUDE_API_KEY)}
  fi
  if [ -n "$mock_retries" ]; then export CLAUDE_CODE_MAX_RETRIES="$mock_retries"; fi
  export ANTHROPIC_BASE_URL="$mock_base_url"
  export INFINITARY_MOCK_CLAUDE_KEYCHAIN_LOG="$HOME/${STATE_DIR}/keychain-lookups.log"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  export DISABLE_AUTOUPDATER=1
  export PATH=${shellLiteral(shimDir)}:"$PATH"
  exec "$mock_client" "$@"
fi
exec ${shellLiteral(process.execPath)} ${shellLiteral(path)} "$@"
`,
      { mode: 0o755 },
    );
    chmodSync(launcher, 0o755);
  }
  const prepared = { launcher, shimDir };
  boxedHolder[BOXED_KEY] = prepared;
  return prepared;
}

/**
 * INF-2394 measure 1: one owner for a signed-in throwaway HOME.
 * The stand-in client reads its marker; the product reads its credential file.
 * A seat relaunch preserves credentials changed by the journey, like a real home.
 */
export type ClaudeHomeCredentials = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number;
  subscriptionType?: string;
};

export function signedInClaudeHome(
  homeDir: string,
  options: { preserveCredentials?: boolean; credentials?: ClaudeHomeCredentials } = {},
): void {
  const store = claudeDefaultStore(homeDir);
  seedSignedInClaudeStore(store);
  if (!options.preserveCredentials) seedClaudeCredentialFile(store, options.credentials);
}

/** Seed the machine's default Claude store as an already-signed-in one. */
function seedSignedInClaudeStore(accountDir: string): void {
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountDir, "stub-credential"), "stub", { mode: 0o600 });
}

/**
 * Seed the store's own credential FILE, shaped like the client writes it
 * where no Keychain serves it: what `readClaudeStore` reads
 * when no client can be asked. Fake tokens, a far-future expiry.
 */
function seedClaudeCredentialFile(
  accountDir: string,
  credentials: ClaudeHomeCredentials = {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: 4_000_000_000_000,
    refreshTokenExpiresAt: 4_000_000_000_000,
  },
): void {
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(accountDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: credentials,
    }),
    { mode: 0o600 },
  );
}
