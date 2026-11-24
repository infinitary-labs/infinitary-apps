import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  answerText,
  type StubApi,
  startStubApi,
  writeAnthropicError,
} from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { accessFlagSettings, type ClaudeAccessSettings, readClaudeAccess } from "./claudeAccess";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// Measured on an Apple silicon Mac: the case takes 1.4 s, one boxed client
// turn with two requests, like the sibling real-client cases, which hold
// 15 s from the hosted Linux check machine's measure; it keeps theirs.
vi.setConfig({ testTimeout: 15_000 });

/**
 * A Claude crewmate signs in with a person's own Claude Code gateway: the
 * token command and the address from their Claude settings (INF-3449, the
 * captain's words: "Take the gateway address and token command from the
 * person's own Claude settings too"). The client the product would run is
 * boxed by the e2e stub with no key and no address of its own
 * (`credential: "settings"`), so the only way its turn reaches the stand-in
 * gateway is the flag settings the session hands it.
 *
 * The token command is a script the case writes, printing a new token each
 * time it runs. The gateway refuses the first one, the way it refuses an
 * expired token: the client runs the command again and the turn finishes on
 * the second, with no browser sign-in anywhere.
 */

const MODEL = "claude-haiku-4-5";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** A token command that prints `gateway-token-<n>` on its n-th run, counting runs in `count`. */
function tokenCommand(home: string): { command: string; runs: () => number } {
  const count = join(home, "token-runs");
  writeFileSync(count, "0");
  const command = join(home, "gateway-token");
  writeFileSync(
    command,
    `#!/bin/sh\nn=$(( $(cat "${count}") + 1 ))\nprintf '%s' "$n" > "${count}"\nprintf 'gateway-token-%s\\n' "$n"\n`,
  );
  chmodSync(command, 0o755);
  return { command, runs: () => Number(readFileSync(count, "utf8")) };
}

/** A crewmate in a throwaway HOME whose client signs in only through `access`. */
function boxedCrewmate(
  access: (home: string) => ClaudeAccessSettings | Promise<ClaudeAccessSettings>,
) {
  const home = scratchDir("infinitary-claude-access-home-");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "settings", ...(client ? { client } : {}) },
  });
  const settings = Promise.resolve(access(home));
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
    accessSettings: () => settings,
  });
  const spec = crewmateSessionSpec(
    appPathsFor(scratchDir("infinitary-claude-access-app-")),
    {
      ...crewmateToolDelegate(),
      machineId: LOCAL_MACHINE_ID,
      cwd: home,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    },
    { backend: "claude", accountId: "acct_claude_access" },
  );
  return { factory, spec };
}

describe("a Claude crewmate on the gateway in the person's Claude settings", () => {
  it("finishes its turn on the token the command prints, renewed after a refusal", async () => {
    let token: ReturnType<typeof tokenCommand> | undefined;
    const crewmate = boxedCrewmate((home) => {
      token = tokenCommand(home);
      return { apiKeyHelper: token.command, env: { ANTHROPIC_BASE_URL: api.url } };
    });
    api.answer((request, res) => {
      if (request.credential === "gateway-token-1") {
        writeAnthropicError(res, 401, { type: "authentication_error", message: "token expired" });
        return;
      }
      answerText(request, res, "Aye from the gateway.");
    });
    const from = api.requests.length;
    const session = await crewmate.factory.open(crewmate.spec);
    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("Say aye.");
    session.dispose();
    await session.closed();
    const sent = api.requests.slice(from);
    expect(
      sent.map((request) => request.credential),
      "the gateway saw the refused token, then the renewed one",
    ).toEqual(["gateway-token-1", "gateway-token-2"]);
    expect(token?.runs(), "the client ran the command again after the refusal").toBe(2);
    expect(JSON.stringify(events), "the answer reached the crewmate").toContain(
      "Aye from the gateway.",
    );
  });

  // The header from the settings file, from the login shell, and the settings file winning over the shell.
  it.each([
    { from: "the person's settings file", shell: undefined, settings: "X-Team-Id: platform" },
    { from: "the login shell", shell: "X-Team-Id: platform", settings: undefined },
    {
      from: "the settings file over the login shell",
      shell: "X-Team-Id: shell",
      settings: "X-Team-Id: platform",
    },
  ])("sends the gateway's custom header from $from", async ({ shell, settings }) => {
    const crewmate = boxedCrewmate(async (home) => {
      const token = tokenCommand(home);
      const config = join(home, "claude-settings");
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, "settings.json"),
        JSON.stringify({
          apiKeyHelper: token.command,
          env: {
            ANTHROPIC_BASE_URL: api.url,
            ...(settings ? { ANTHROPIC_CUSTOM_HEADERS: settings } : {}),
          },
        }),
      );
      vi.stubEnv("CLAUDE_CONFIG_DIR", config);
      return accessFlagSettings(
        await readClaudeAccess(undefined, () =>
          shell ? { ANTHROPIC_CUSTOM_HEADERS: shell } : undefined,
        ),
      );
    });
    api.answer((request, res) => answerText(request, res, "Aye from the gateway."));
    const from = api.requests.length;
    const session = await crewmate.factory.open(crewmate.spec);
    await session.prompt("Say aye.");
    session.dispose();
    await session.closed();
    const sent = api.requests.slice(from);
    expect(sent.length, "the turn reached the gateway").toBeGreaterThan(0);
    expect(
      sent.map((request) => request.headers["x-team-id"]),
      "every request carried the gateway's custom header",
    ).toEqual(sent.map(() => "platform"));
    expect(sent.map((request) => request.credential)).toEqual(sent.map(() => "gateway-token-1"));
  });
});
