import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANTIGRAVITY_MISSING_TEXT, ANTIGRAVITY_PROVIDER_ID } from "@shared/antigravity";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import type { AgyCommandScenario } from "../../../tests/helpers/agyCommandStandIn";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { ANTIGRAVITY_LOGIN_WORDS, AntigravityAuthBackend, signInLink } from "./antigravityAuth";
import { readUsageReport } from "./antigravityUsage";

/**
 * Intent: INF-3776's approved plan, its second pull request - "Sign-in
 * runs the program's own `agy acp --login`" and the allowance is "agy -p
 * /usage --output-format json --print-timeout 20s, run only when the person
 * opens Subscriptions or presses Recheck allowance ... with automatic
 * updates off" - under the captain's constraint that Infinitary never reads
 * the program's saved sign-in. The stand-in (`tests/helpers/agyCommandStandIn.ts`)
 * plays the program as a real child process; no Google sign-in is used.
 */

const STAND_IN = join(import.meta.dirname, "../../../tests/helpers/agyCommandStandIn.ts");
const ACCOUNT = {
  providerId: ANTIGRAVITY_PROVIDER_ID,
  accountId: "acct_agy",
  // The account's folder in the vault, which the program's sign-in never uses.
  dir: "/nonexistent/accounts/google-antigravity/acct_agy",
};

function program(scenario: AgyCommandScenario) {
  const dir = scratchDir("infinitary-agy-command-");
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "agy-log.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(logPath, "");
  const launch = (args: string[]) => () => ({
    command: process.execPath,
    args: [STAND_IN, scenarioPath, logPath, ...args],
  });
  const log = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { launch, log };
}

function bridge(answer: string | Error = "") {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  const opened: string[] = [];
  const controller = new AbortController();
  const value: AuthInteractionBridge = {
    prompt: async (prompt) => {
      prompts.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    notify: (notice) => notices.push(notice),
    openExternal: async (url) => {
      opened.push(url);
    },
    signal: controller.signal,
  };
  return { value, notices, prompts, opened, stop: () => controller.abort() };
}

describe("signing in to Antigravity", () => {
  it("opens the link the program prints and hands the program the code Google's page shows", async () => {
    // The program's own words, read from a real `agy acp --login`, with its
    // link cut to the parts the sign-in reads.
    const link = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=agy";
    const agy = program({
      login: {
        stdout: `Open this link in a browser to log in with Google:\n\n  ${link}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`,
        readCode: true,
        exit: 0,
      },
    });
    const backend = new AntigravityAuthBackend({ launch: agy.launch(["acp", "--login"]) });
    const login = bridge("4/0Abc-code");

    await backend.login({ ...ACCOUNT, type: "oauth", bridge: login.value });

    expect(login.opened).toEqual([link]);
    expect(login.notices).toContainEqual(expect.objectContaining({ kind: "auth_url", url: link }));
    expect(login.prompts.map((prompt) => prompt.kind)).toEqual(["manual_code"]);
    expect(agy.log()).toEqual([
      expect.objectContaining({ args: ["acp", "--login"] }),
      { code: "4/0Abc-code" },
    ]);
    // Removing the account never signs the program out.
    expect(await backend.logout({ ...ACCOUNT })).toEqual({ login: "kept" });
  });

  it("says the sign-in did not finish when the program exits without signing in", async () => {
    const agy = program({ login: { stderr: "login cancelled\n", exit: 1 } });
    const backend = new AntigravityAuthBackend({ launch: agy.launch(["acp", "--login"]) });

    await expect(
      backend.login({ ...ACCOUNT, type: "oauth", bridge: bridge().value }),
    ).rejects.toThrow(ANTIGRAVITY_LOGIN_WORDS.unfinished);
  });

  it("stops the program when the person stops the sign-in", async () => {
    const agy = program({
      login: {
        stdout: "Open https://accounts.google.com/o/oauth2/auth?client_id=agy\n",
        hang: true,
      },
    });
    const backend = new AntigravityAuthBackend({ launch: agy.launch(["acp", "--login"]) });
    const login = bridge();

    const signingIn = backend.login({ ...ACCOUNT, type: "oauth", bridge: login.value });
    await vi.waitFor(() =>
      expect(login.notices.map((notice) => notice.kind)).toContain("auth_url"),
    );
    login.stop();

    await expect(signingIn).rejects.toThrow("The sign-in was stopped.");
    expect(agy.log()).toContainEqual({ stopped: true });
  });

  it("stops the program at once when the person leaves the code prompt", async () => {
    // Reviewer's finding: a left prompt kept the program waiting until the
    // sign-in's timeout, and its one login refused another try meanwhile.
    const agy = program({
      login: {
        stdout:
          "Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=agy\n\n",
        readCode: true,
        exit: 0,
      },
    });
    const backend = new AntigravityAuthBackend({ launch: agy.launch(["acp", "--login"]) });

    await expect(
      backend.login({ ...ACCOUNT, type: "oauth", bridge: bridge(new Error("cancelled")).value }),
    ).rejects.toThrow("The sign-in was stopped.");
    expect(agy.log()).toContainEqual({ stopped: true });
  });

  it("opens the link only once the program has printed it whole", () => {
    // Reviewer's finding: a link split across two reads opened cut short.
    const link = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=agy";
    expect(signInLink(`Open this link:\n\n  ${link.slice(0, 40)}`)).toBeUndefined();
    expect(signInLink(`Open this link:\n\n  ${link}\n`)).toBe(link);
  });

  it("offers no sign-in, and says why, on a computer without the program", async () => {
    const backend = new AntigravityAuthBackend({ launch: () => undefined });

    expect(backend.authTypes(ANTIGRAVITY_PROVIDER_ID)).toEqual([]);
    expect(backend.unavailable()?.detail).toBe(ANTIGRAVITY_MISSING_TEXT);
    await expect(
      backend.login({ ...ACCOUNT, type: "oauth", bridge: bridge().value }),
    ).rejects.toThrow(ANTIGRAVITY_MISSING_TEXT);
    expect(await backend.health({ ...ACCOUNT })).toMatchObject({
      state: "degraded",
      detail: ANTIGRAVITY_MISSING_TEXT,
    });
  });
});

describe("reading the Antigravity allowance", () => {
  it("runs the usage report with the program's automatic update off and its account line hidden", async () => {
    // The program's real answer, its conversation id replaced.
    const report = readFileSync("tests/fixtures/antigravity/usage-report.json", "utf8");
    const agy = program({ print: { stdout: report, exit: 0 } });

    const read = await readUsageReport({
      launch: agy.launch(["-p", "/usage", "--output-format", "json"]),
    });

    expect(read).toMatchObject({ status: "ok", windows: [{ windowId: "seven_day" }] });

    expect(agy.log()).toEqual([
      {
        args: ["-p", "/usage", "--output-format", "json"],
        env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1", AGY_CLI_HIDE_ACCOUNT_INFO: "1" },
      },
    ]);
  });

  it("stops a report that never answers, and reads it as nothing", async () => {
    // The report's wait is held still until the stand-in has started and can
    // hear the stop; on a loaded computer a real 200 ms ran out before it
    // had (merge batch send-back), so the stop went unrecorded.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const agy = program({ print: { hang: true } });
      const reading = readUsageReport({ launch: agy.launch(["-p", "/usage"]), waitMs: 200 });
      while (agy.log().length === 0) await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(200);
      const read = await reading;

      expect(read.status).toBe("unreadable");
      expect(agy.log()).toContainEqual({ stopped: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
