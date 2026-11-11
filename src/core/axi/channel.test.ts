import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { deferred } from "../../../tests/helpers/deferred";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BrowserAnswer } from "../browser/crewmateCommands";
import type { CrewmateBrowser } from "../browser/taskBrowsers";
import type { TaskFiles } from "../files/taskFiles";
import { hostEnv } from "../hostEnv";
import type { IntegrationAnswer, TaskIntegrations } from "../integrations";
import { JobManager } from "../jobs/jobManager";
import { SECRETS_CHECK_WORDS, SECRETS_ELSEWHERE_HELP } from "../secrets/commandWords";
import { type Injection, SECRETS_COMMAND, SecretRequests } from "../secrets/requests";
import { forkChildProcess } from "../sql/forkChildProcess";
import { BROWSER_COMMANDS } from "./browserCommands";
import { AxiChannel, SHELL_CAP_ENV, SHELL_STARTED_ENV, type TaskShell } from "./channel";

/**
 * The task channel for real: the shell launcher in `resources/axi-bin`,
 * run by `sh` with the system's curl, reaching the app's socket with the
 * key its task's file holds; the command process bundled as the app
 * bundles it and forked with Node; and a stand-in for the task's browser,
 * so what reaches a browser - and what never does - is read off its calls.
 */

vi.setConfig({ testTimeout: 30_000 });

const BIN_DIR = resolve(__dirname, "../../../resources/axi-bin");

let entry: string;
const channels: AxiChannel[] = [];

beforeAll(async () => {
  entry = await bundleAxiProcess();
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  for (const channel of channels.splice(0)) channel.close();
});

function page(title: string, did: string, extra: Partial<BrowserAnswer> = {}): BrowserAnswer {
  return {
    text: `Page: "${title}" at http://127.0.0.1:5555/\nrefs: g1\ndid: ${did}`,
    page: { title, url: "http://127.0.0.1:5555/", refs: "g1", controls: 2, errors: 0, did },
    body: 'outline: lines 1-2 of 2\nheading "Sign up" (level 1)\n  textbox "Name" [g1:e1]',
    next: [],
    ...extra,
  };
}

/** A stand-in for one task's browser: every call recorded, each answered as given. */
function standIn(title: string): CrewmateBrowser & { calls: { op: string; input: unknown }[] } {
  const calls: { op: string; input: unknown }[] = [];
  const record =
    (op: string, answer: () => Promise<BrowserAnswer>) =>
    async (input?: unknown): Promise<BrowserAnswer> => {
      calls.push({ op, input });
      return answer();
    };
  return {
    calls,
    navigate: record("navigate", async () => page(title, "Opened http://127.0.0.1:5555/.")),
    inspect: record("inspect", async () => page(title, "Read the page.")),
    act: record("act", async () => page(title, 'Clicked button "Send" [g1:e2].')),
    capture: record("capture", async () => ({
      ...page(title, "Saved the visible page."),
      image: { data: "AAAA", mimeType: "image/png" },
      picture: { path: "/evidence/page-1.png", width: 1280, height: 800, what: "the visible page" },
    })),
    close: record("close", async () => ({ text: "Stopped this task's browser." })),
    pages: record("pages", async () => ({
      text: "One page is open.",
      pages: [{ place: 1, title, url: "http://127.0.0.1:5555/", current: true }],
    })),
  };
}

async function openChannel(
  keysDir = join(scratchDir("infinitary-axi-channel-"), "task-channel"),
  answering?: (shell: string) => void,
) {
  const channel = await AxiChannel.open({
    spawner: forkChildProcess(entry),
    binDir: BIN_DIR,
    version: "9.9.9-test",
    keysDir,
    ...(answering ? { answering } : {}),
  });
  channels.push(channel);
  return channel;
}

type Run = { stdout: string; exitCode: number };

/** One request to the channel as anything on this Mac could send it, with the headers given. */
function fetchRun(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/run", headers, setHost: false },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        response.on("end", () => done(text));
      },
    );
    request.on("error", fail);
    request.end("tool=infinitary-browser-axi&arg=snapshot");
  });
}

/** Run the launcher the way a task's shell does: by name, on the path the grant gave. */
function shell(
  granted: TaskShell | undefined,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  command = "infinitary-browser-axi",
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: [...(granted?.path ?? [BIN_DIR]), process.env.PATH ?? ""].join(":"),
    HOME: process.env.HOME,
    ...(granted?.env ?? {}),
    ...extra,
  };
  return new Promise((done) => {
    execFile("/bin/sh", ["-c", `${command} "$@"`, "sh", ...args], { env }, (error, stdout) => {
      const exitCode = error ? Number((error as { code?: number }).code ?? 1) : 0;
      done({ stdout, exitCode });
    });
  });
}

describe("the task channel and the infinitary-browser-axi launcher", () => {
  it("reaches only the browser its key names, with the key never on a command line or in the environment", async () => {
    const channel = await openChannel();
    const mine = standIn("Mine");
    const theirs = standIn("Theirs");
    const granted = channel.grant("task-a", { browser: mine });
    channel.grant("task-b", { browser: theirs });

    const opened = await shell(granted, ["open", "http://127.0.0.1:5555/"]);
    expect(opened.exitCode).toBe(0);
    expect(decode(opened.stdout.split("\noutline:")[0] ?? "")).toMatchObject({
      page: { title: "Mine", url: "http://127.0.0.1:5555/", refs: "g1", controls: 2, errors: 0 },
      did: "Opened http://127.0.0.1:5555/.",
    });
    expect(opened.stdout).toContain('textbox "Name" [g1:e1]');
    expect(mine.calls).toEqual([{ op: "navigate", input: { url: "http://127.0.0.1:5555/" } }]);
    expect(theirs.calls).toEqual([]);

    // The shell carries where the key is, never the key; the file is its owner's alone.
    const keyFile = granted.env.INFINITARY_AXI_KEY as string;
    const key = readFileSync(keyFile, "utf8").trim().split(": ")[1] as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(granted.env).join("\n")).not.toContain(key);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(keyFile, "..")).mode & 0o777).toBe(0o700);

    // A key of its own making names no task, and a shell with none never asks.
    const forged = join(scratchDir("infinitary-axi-forged-"), "k");
    writeFileSync(forged, `x-infinitary-axi-key: ${"0".repeat(64)}\n`, { mode: 0o600 });
    for (const file of [forged, `${forged}-missing`]) {
      const stranger = await shell(
        { env: { ...granted.env, INFINITARY_AXI_KEY: file }, path: granted.path },
        ["open", "http://127.0.0.1:5555/"],
      );
      expect(stranger.exitCode).toBe(1);
      expect(stranger.stdout).toContain("code: NO_CHANNEL");
    }

    // A web page can reach a loopback port too: a request naming another
    // host, or carrying an origin, is refused even with the task's own key.
    const [host, port] = (granted.env.INFINITARY_AXI_ADDRESS as string).split(":");
    const asked: Record<string, string>[] = [
      { host: `rebound.example:${port}` },
      { host: `${host}:${port}`, origin: "https://page.example" },
    ];
    for (const headers of asked) {
      const response = await fetchRun(Number(port), { ...headers, "x-infinitary-axi-key": key });
      expect(response).toContain("NO_CHANNEL");
    }

    // A revoked task's key names nothing any more.
    channel.revoke("task-a");
    const revoked = await shell(granted, ["snapshot"]);
    expect(revoked.exitCode).toBe(1);
    expect(revoked.stdout).toContain("NO_CHANNEL");
    expect(mine.calls).toHaveLength(1);
    expect(theirs.calls).toEqual([]);
  });

  it("keeps its keys in the app's own folder, emptied when it opens and when it closes", async () => {
    const keysDir = join(scratchDir("infinitary-axi-keys-"), "task-channel");
    const first = await openChannel(keysDir);
    const stale = first.grant("task-a", { browser: standIn("Sign up") }).env
      .INFINITARY_AXI_KEY as string;
    // A run that was killed never closed its channel: the next one opens on what it left.
    const next = await openChannel(keysDir);
    expect(existsSync(stale)).toBe(false);
    expect(statSync(keysDir).mode & 0o777).toBe(0o700);
    next.grant("task-b", { browser: standIn("Sign up") });
    expect(readdirSync(keysDir)).toHaveLength(1);
    next.close();
    expect(existsSync(keysDir)).toBe(false);
    first.close();
  });

  it("prints a refusal as an error with exit 1, and a malformed command with exit 2 before reaching the browser", async () => {
    const channel = await openChannel();
    const browser = standIn("Sign up");
    browser.act = vi.fn(async () => ({
      text: "g0:e9 is from a page this browser showed before it moved to a new address or closed, so it is not used on the page now.",
      refused: "refused" as const,
    }));
    const granted = channel.grant("task-a", { browser });

    const stale = await shell(granted, ["click", "@g0:e9"]);
    expect(stale.exitCode).toBe(1);
    expect(decode(stale.stdout)).toMatchObject({ code: "REFUSED" });
    expect(stale.stdout).toContain("before it moved to a new address");

    for (const args of [
      ["snapshot", "--bogus"],
      ["press", "Explode"],
      ["click"],
      ["eval", "1"],
      ["update"],
    ]) {
      const answer = await shell(granted, args);
      expect(answer.exitCode, args.join(" ")).toBe(2);
      expect(answer.stdout).toContain("error:");
    }
    expect(browser.calls).toEqual([]);
  });

  it("answers help and the version without a task, and lists no command outside the approved table", async () => {
    const version = await shell(undefined, ["-v"], { INFINITARY_AXI_VERSION: "1.2.3" });
    expect(version).toMatchObject({ exitCode: 0, stdout: "1.2.3\n" });
    const noChannel = await shell(undefined, ["snapshot"]);
    expect(noChannel.exitCode).toBe(1);
    expect(noChannel.stdout).toContain("NO_CHANNEL");

    const channel = await openChannel();
    const browser = standIn("Sign up");
    const granted = channel.grant("task-a", { browser });
    const help = await shell(granted, ["--help"]);
    expect(help.exitCode).toBe(0);
    const listed = (decode(help.stdout) as { commands: { command: string }[] }).commands.map(
      (each) => each.command,
    );
    // The approved table is browserCommands.test.ts's to type; the launcher's help lists exactly it.
    expect(listed.sort()).toEqual(Object.keys(BROWSER_COMMANDS).sort());
    const clickHelp = await shell(granted, ["click", "--help"]);
    expect(decode(clickHelp.stdout)).toMatchObject({
      command: "click",
      usage: "infinitary-browser-axi click @ref",
    });
    expect(browser.calls).toEqual([]);
  });

  it("keeps an answer that runs past the shell's limit for the next command, never sending it twice", async () => {
    const channel = await openChannel();
    const browser = standIn("Sign up");
    let release: (() => void) | undefined;
    browser.act = vi.fn(
      () =>
        new Promise<BrowserAnswer>((done) => {
          release = () => done(page("Sign up", 'Clicked button "Send" [g1:e2].'));
        }),
    );
    const granted = channel.grant("task-a", { browser });
    const limit = { [SHELL_CAP_ENV]: "1500" };

    const click = await shell(granted, ["click", "@g1:e2"], limit);
    expect(click.exitCode).toBe(0);
    // It answered while the click was still running in the browser.
    expect(decode(click.stdout)).toMatchObject({ running: "click" });
    expect(release).toBeDefined();

    // Still running: the next command is not run, and says so.
    const busy = await shell(granted, ["snapshot"], limit);
    expect(busy.exitCode).toBe(1);
    expect(decode(busy.stdout)).toMatchObject({ code: "BUSY" });

    release?.();
    const look = await shell(granted, [], limit);
    expect(look.exitCode).toBe(0);
    expect(look.stdout).toContain("earlier: Your earlier click finished");
    expect(look.stdout).toContain('did: "Clicked button \\"Send\\" [g1:e2]."');
    expect(browser.act).toHaveBeenCalledTimes(1);
    expect(browser.calls.filter((call) => call.op === "inspect")).toEqual([]);
  });

  it("returns a command's answer through Pi's shell when the app is held up past the shell's limit", async () => {
    // INF-531: on a loaded Mac the app's process did not run from before the
    // channel's deadline until after Pi's limit. When it ran again, Pi's
    // limit turned a look into a background job before its answer came
    // back. The channel now tells Pi's shell that the command reached it.
    const jobs = new JobManager({ onExit: () => {} });
    const channel = await openChannel(undefined, (shell) => jobs.answering(shell));
    const browser = standIn("Sign up");
    let looked: () => void = () => {};
    const looking = new Promise<void>((resolve) => {
      looked = resolve;
    });
    // The page never shows the words: the wait runs on in the browser.
    browser.inspect = vi.fn(() => {
      looked();
      return new Promise<BrowserAnswer>(() => {});
    });
    const granted = channel.grant("task-a", { browser });
    const cap = 1_500;
    // The shell's limit and the channel's deadline run on a clock the test
    // moves, so the look reaches the browser before either runs out however
    // long a loaded Mac takes to start the launcher (INF-1175).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = jobs.run({
      ownerId: "task-a",
      command: "infinitary-browser-axi wait Ready",
      cwd: "/tmp",
      capMs: cap,
      shell: granted,
    });
    // The look reached the browser: the launcher reached the app, which told
    // the shell, and the channel's deadline (750 ms before the limit) counts.
    await looking;
    // This process stops running from before that deadline until after the
    // limit, as the app's did: both run out back to back, before any answer
    // comes back.
    vi.advanceTimersByTime(cap + 300);

    const outcome = await running;
    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") return;
    expect(outcome.exitCode).toBe(0);
    expect(decode(outcome.output)).toMatchObject({ running: "wait" });
    expect(browser.inspect).toHaveBeenCalledTimes(1);
  });

  // INF-2004: interrupted load claims may repeat, but an effectful command may not.
  it("keeps a timed-out browser action terminal and never labels it as a repeatable claim", async () => {
    const channel = await openChannel();
    const browser = standIn("Sign up");
    const entered = deferred<void>();
    const delayed = deferred<BrowserAnswer>();
    browser.act = vi.fn(() => {
      entered.resolve();
      return delayed.promise;
    });
    const granted = channel.grant("task-a", { browser });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = shell(granted, ["click", "@g1:e2"]);
    await entered.promise;
    vi.advanceTimersToNextTimer();
    vi.useRealTimers();
    const answer = await running;
    expect(answer.exitCode).toBe(1);
    expect(decode(answer.stdout)).toMatchObject({ code: "FAILED" });
    delayed.resolve(page("Sign up", "Clicked once."));
    expect(browser.act).toHaveBeenCalledTimes(1);
  });

  // INF-2004: curl's documented timeout exit is a lost answer, not a refusal.
  // Inject that transport result at curl's executable seam while running the
  // real launcher; no real task key, network destination or app state is used.
  it("marks transport timeouts recoverable only for native load claims and launch receipts", async () => {
    const dir = scratchDir("infinitary-axi-transport-timeout-");
    const curl = join(dir, "curl");
    writeFileSync(curl, "#!/bin/sh\nexit 28\n", { mode: 0o700 });
    const launcher = readFileSync(join(BIN_DIR, "infinitary-axi"), "utf8").replace(
      "curl=/usr/bin/curl",
      `curl='${curl.replaceAll("'", "'\"'\"'")}'`,
    );
    for (const name of ["infinitary-load-axi", "infinitary-browser-axi"])
      writeFileSync(join(dir, name), launcher, { mode: 0o700 });
    const channel = await openChannel();
    const granted = channel.grant("transport", { browser: standIn("Sign up") });
    const fixture = { ...granted, path: [dir] };
    const claim = await shell(
      fixture,
      ["claim", "--pid", "1", "--processors", "2", "--memory-mib", "2048"],
      {},
      "infinitary-load-axi",
    );
    expect(claim.exitCode).toBe(1);
    expect(decode(claim.stdout)).toMatchObject({ code: "CLAIM_UNAVAILABLE" });
    // INF-2228: a receipt timeout repeats only receipt bookkeeping, never launch.
    const receipt = await shell(
      fixture,
      [
        "receipt",
        "--hold",
        "saved-hold",
        "--pid",
        "1",
        "--payload",
        "118",
        "--started",
        "Tue Oct 27 11:03:36 2026",
      ],
      {},
      "infinitary-load-axi",
    );
    expect(receipt.exitCode).toBe(1);
    expect(decode(receipt.stdout)).toMatchObject({ code: "RECEIPT_UNAVAILABLE" });
    for (const [name, args] of [
      ["infinitary-load-axi", []],
      ["infinitary-browser-axi", ["click", "@g1:e2"]],
    ] as const) {
      const answer = await shell(fixture, [...args], {}, name);
      expect(answer.exitCode).toBe(1);
      expect(decode(answer.stdout)).toMatchObject({ code: "NO_CHANNEL" });
    }
  });

  it("counts the shell's limit from when the shell started, while that shell can still answer", async () => {
    // INF-181: a click that finishes after the start-counted deadline, and
    // before the receipt-counted one, must answer running. Receipt counting
    // would return the click.
    const channel = await openChannel();
    const browser = standIn("Sign up");
    const cap = 3_000;
    const started = Date.now() - 1_600;
    let clickDone: () => void = () => {};
    const clickSettled = new Promise<void>((resolve) => {
      clickDone = resolve;
    });
    browser.act = vi.fn(
      () =>
        new Promise<BrowserAnswer>((done) => {
          setTimeout(() => {
            done(page("Sign up", 'Clicked button "Send" [g1:e2].'));
            clickDone();
          }, 800);
        }),
    );
    const granted = channel.grant("task-a", { browser });

    const click = await shell(granted, ["click", "@g1:e2"], {
      [SHELL_CAP_ENV]: String(cap),
      [SHELL_STARTED_ENV]: String(started),
    });
    expect(click.exitCode).toBe(0);
    expect(decode(click.stdout)).toMatchObject({ running: "click" });
    expect(browser.act).toHaveBeenCalledTimes(1);
    await clickSettled;

    // A finished kept answer wins even though this later command's deadline
    // has passed and the shell can still answer. The early timeout used to
    // print BUSY forever, including a poll.
    const lookCap = 3_000;
    const lookStarted = Date.now() - (lookCap - 650);
    const look = await shell(granted, [], {
      [SHELL_CAP_ENV]: String(lookCap),
      [SHELL_STARTED_ENV]: String(lookStarted),
    });
    expect(look.exitCode).toBe(0);
    expect(look.stdout).toContain("earlier: Your earlier click finished");
    expect(look.stdout).not.toContain("BUSY");
    expect(browser.act).toHaveBeenCalledTimes(1);

    // A shell that has just started, with room to spare, still returns a fast click.
    browser.act = vi.fn(async () => page("Sign up", 'Clicked button "Send" [g1:e2].'));
    const fresh = await shell(granted, ["click", "@g1:e2"], {
      [SHELL_CAP_ENV]: "30000",
      [SHELL_STARTED_ENV]: String(Date.now()),
    });
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout).toContain('did: "Clicked button \\"Send\\" [g1:e2]."');
    expect(fresh.stdout).not.toContain("running: click");
    expect(browser.act).toHaveBeenCalledTimes(1);

    // Once the cap has already run out, count from receipt: a short click answers.
    browser.act = vi.fn(
      () =>
        new Promise<BrowserAnswer>((done) => {
          setTimeout(() => done(page("Sign up", 'Clicked button "Send" [g1:e2].')), 200);
        }),
    );
    const past = await shell(granted, ["click", "@g1:e2"], {
      [SHELL_CAP_ENV]: "30000",
      [SHELL_STARTED_ENV]: String(Date.now() - 30_000),
    });
    expect(past.exitCode).toBe(0);
    expect(past.stdout).toContain('did: "Clicked button \\"Send\\" [g1:e2]."');
    expect(past.stdout).not.toContain("running: click");

    // A start after the request arrived cannot extend the receipt-counted limit.
    let held: (() => void) | undefined;
    browser.act = vi.fn(
      () =>
        new Promise<BrowserAnswer>((done) => {
          held = () => done(page("Sign up", 'Clicked button "Send" [g1:e2].'));
        }),
    );
    const late = await shell(granted, ["click", "@g1:e2"], {
      [SHELL_CAP_ENV]: "1500",
      [SHELL_STARTED_ENV]: String(Date.now() + 60_000),
    });
    held?.();
    expect(late.exitCode).toBe(0);
    expect(decode(late.stdout)).toMatchObject({ running: "click" });
  });
});

// INF-775 piece 1, the captain's q1: one command on the task channel, discover then call.
describe("the infinitary-integrations-axi command", () => {
  /** A task's integrations as `IntegrationsService.forTask` answers them; every call recorded. */
  function integrationsStandIn(): TaskIntegrations & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const github = { name: "GitHub", id: "github", kind: "github", account: "octo", health: "ok" };
    return {
      calls,
      list: async () => [
        { ...github, actions: "read (reads, Allowed), write (changes, Asks you)" },
      ],
      show: async (name) =>
        name === "GitHub"
          ? { integration: "GitHub", actions: [{ name: "read", effect: "reads", rule: "allow" }] }
          : ({ text: `No integration is named ${name}.`, refused: "refused" } as IntegrationAnswer),
      call: async (name, action, input) => {
        calls.push([name, action, input]);
        return action === "write"
          ? {
              text: "Not sent: it goes through the GitHub integration. Kept as ask a1.",
              refused: "refused",
            }
          : { text: '{"status": 200, "body": {"login": "octo"}}' };
      },
    };
  }
  const run = (granted: TaskShell | undefined, args: string[]) =>
    shell(granted, args, {}, "infinitary-integrations-axi");

  it("lists, shows and calls only the integrations its task was granted", async () => {
    const channel = await openChannel();
    const integrations = integrationsStandIn();
    const granted = channel.grant("task-a", { integrations });

    const home = await run(granted, []);
    expect(home.exitCode).toBe(0);
    expect(decode(home.stdout.split("\nhelp")[0] ?? "")).toMatchObject({
      integrations: [{ name: "GitHub", account: "octo" }],
    });
    const shown = await run(granted, ["show", "GitHub"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("read");
    expect((await run(granted, ["show", "Gmail"])).exitCode).toBe(1);

    const read = await run(granted, ["call", "GitHub", "read", '{"path":"/user"}']);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('"login": "octo"');
    const write = await run(granted, ["call", "GitHub", "write", '{"method":"POST","path":"/x"}']);
    expect(write.exitCode).toBe(1);
    expect(decode(write.stdout)).toMatchObject({ code: "REFUSED" });
    expect(write.stdout).toContain("Kept as ask a1");

    // A malformed input never reaches the integration.
    expect((await run(granted, ["call", "GitHub", "read", "{nope"])).exitCode).toBe(2);
    expect((await run(granted, ["call", "GitHub", "read", "[1]"])).exitCode).toBe(2);
    expect(integrations.calls).toEqual([
      ["GitHub", "read", { path: "/user" }],
      ["GitHub", "write", { method: "POST", path: "/x" }],
    ]);

    // A task granted only a browser has no integrations command, and the other way round.
    const browserOnly = channel.grant("task-b", { browser: standIn("Sign up") });
    expect((await run(browserOnly, [])).stdout).toContain("code: NO_TOOL");
    expect((await shell(granted, ["snapshot"])).stdout).toContain("code: NO_TOOL");
  });
});

// The captain's choice for INF-2468: read any file on another of their
// computers through one command, with no click, each copy one line on the record.
describe("the infinitary-files-axi command", () => {
  /** A task's files command as `FileRouter.forTask` answers it; every list and copy recorded. */
  function filesStandIn(copy?: () => Promise<void>): TaskFiles & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      computers: async () => ({
        data: {
          computers: [
            {
              name: "home",
              role: "the computer where your first mate lives",
              reach: "in reach",
              thisTask: false,
            },
            { name: "Kun's Mac mini", role: "runs work", reach: "in reach", thisTask: true },
          ],
        },
      }),
      list: async (target) => {
        calls.push(["list", target]);
        return {
          data: {
            computer: "home",
            folder: "/Users/me/Documents",
            entries: [{ name: "clips.csv", kind: "file", size: 12, modified: null }],
          },
        };
      },
      copy: async (target) => {
        calls.push(["copy", target]);
        await copy?.();
        return target.endsWith("auth.json")
          ? {
              text: "~/auth.json holds the app's own sign-ins or keys, which the files command never copies.",
              refused: "refused",
            }
          : {
              data: {
                copied: "/handover/0123456789abcdef-clips.csv",
                from: "home:/Users/me/Documents/clips.csv",
                size: 12,
                sha256: "0123456789abcdef",
              },
            };
      },
    };
  }
  const run = (granted: TaskShell | undefined, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    shell(granted, args, extra, "infinitary-files-axi");

  it("names the computers, lists a folder and copies one file for the task it was granted to", async () => {
    const channel = await openChannel();
    const files = filesStandIn();
    const granted = channel.grant("task-a", { files });

    const home = await run(granted, []);
    expect(home.exitCode).toBe(0);
    expect(decode(home.stdout.split("\nhelp")[0] ?? "")).toMatchObject({
      computers: [{ name: "home" }, { name: "Kun's Mac mini", thisTask: true }],
    });
    const listed = await run(granted, ["ls", "home:~/Documents"]);
    expect(listed.exitCode).toBe(0);
    expect(decode(listed.stdout.split("\nhelp")[0] ?? "")).toMatchObject({
      entries: [{ name: "clips.csv", kind: "file", size: 12 }],
    });
    const copied = await run(granted, ["get", "home:~/Documents/clips.csv"]);
    expect(copied.exitCode).toBe(0);
    expect(copied.stdout).toContain("copied: /handover/0123456789abcdef-clips.csv");
    expect(copied.stdout).toContain("A copied file may hold secrets");

    const refused = await run(granted, ["get", "home:~/auth.json"]);
    expect(refused.exitCode).toBe(1);
    expect(decode(refused.stdout)).toMatchObject({ code: "REFUSED" });
    expect(refused.stdout).toContain("never copies");

    // A command without a computer, or with two paths, never reaches the home.
    expect((await run(granted, ["get", "~/Documents/clips.csv"])).exitCode).toBe(2);
    expect((await run(granted, ["get", "home:~/a", "home:~/b"])).exitCode).toBe(2);
    expect(files.calls).toEqual([
      ["list", "home:~/Documents"],
      ["copy", "home:~/Documents/clips.csv"],
      ["copy", "home:~/auth.json"],
    ]);

    // A task granted only a browser has no files command.
    const browserOnly = channel.grant("task-b", { browser: standIn("Sign up") });
    expect((await run(browserOnly, [])).stdout).toContain("code: NO_TOOL");
  });

  it("keeps a copy that runs past the shell's limit for the next command, never copying it twice", async () => {
    const channel = await openChannel();
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    const files = filesStandIn(() => held);
    const granted = channel.grant("task-a", { files });
    const limit = { [SHELL_CAP_ENV]: "1500" };

    const copy = await run(granted, ["get", "home:~/Documents/clips.csv"], limit);
    expect(copy.exitCode).toBe(0);
    expect(decode(copy.stdout)).toMatchObject({ running: "get" });

    const busy = await run(granted, ["ls", "home:~/Documents"], limit);
    expect(busy.exitCode).toBe(1);
    expect(decode(busy.stdout)).toMatchObject({ code: "BUSY" });

    release();
    const look = await run(granted, [], limit);
    expect(look.exitCode).toBe(0);
    expect(look.stdout).toContain(
      'earlier: "Your earlier get finished, so this command was not run',
    );
    expect(look.stdout).toContain("copied: /handover/0123456789abcdef-clips.csv");
    expect(files.calls).toEqual([["copy", "home:~/Documents/clips.csv"]]);
  });
});

// Intent: INF-1085 piece 1 and INF-1093's accepted exact-operation boundary.
// Disposable adapters prove orchestration, NOT native custody or authentication.
describe("the Secrets command's disposable operation proof", () => {
  it("discovers, waits, executes once, withholds raw recipient output, reads status and cancels", async () => {
    const channel = await openChannel();
    const value = "invented-disposable-service-token";
    let received: Injection | undefined;
    let executions = 0;
    let captured = "";
    const owner = new SecretRequests({
      list: async () => [{ ref: "s1", label: "Disposable staging", version: "1" }],
      authenticate: async (_id, _digest, _expires, proof) => proof === "fixture-fresh-auth",
      prepare: async (input) => {
        received = input;
        if (input.env.SERVICE_TOKEN !== "s1" || input.argv[0] !== "disposable-recipient")
          return undefined;
        return {
          digest: "fixture-checked-recipient-and-version",
          rule: "ask",
          current: async () => true,
          execute: async () => {
            executions++;
            // The actual recipient receives the invented value; its raw output stays private.
            const base = hostEnv();
            const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
              execFile(
                process.execPath,
                [
                  "-e",
                  "process.stdout.write(process.env.SERVICE_TOKEN); process.stderr.write(Buffer.from(process.env.SERVICE_TOKEN).toString('base64')); process.exitCode=7",
                ],
                {
                  env: { PATH: base.PATH, SERVICE_TOKEN: value },
                },
                (error, stdout, stderr) => {
                  captured = stdout + stderr;
                  expect(stdout === value).toBe(true);
                  expect(stderr === Buffer.from(value).toString("base64")).toBe(true);
                  if (error && typeof error.code !== "number") reject(error);
                  else resolve({ exitCode: error ? Number(error.code) : 0 });
                },
              );
            });
            return result;
          },
          dispose: async () => {
            captured = "";
          },
        };
      },
    });
    const grant = channel.grant("disposable-secrets", { secrets: owner });
    const run = (args: string[]) => shell(grant, args, {}, SECRETS_COMMAND);
    const outputs: string[] = [];
    outputs.push((await run([])).stdout);
    expect(outputs[0]).toContain("Disposable staging");
    expect(decode((await run(["show", "s1"])).stdout)).toMatchObject({
      secret: { ref: "s1", label: "Disposable staging" },
    });
    expect(decode((await run(["show", "not-linked"])).stdout)).toEqual({ unavailable: true });
    const args = [
      "inject",
      "--env",
      '{"SERVICE_TOKEN":"s1"}',
      "--reason",
      "Check staging",
      "--id",
      "staging-1",
      "--",
      "disposable-recipient",
    ];
    const waiting = await run(args);
    expect(waiting.exitCode).toBe(0);
    const receipt = (decode(waiting.stdout) as { receipt: { request: string; state: string } })
      .receipt;
    expect(receipt.state).toBe("waiting");
    expect(executions).toBe(0);
    outputs.push(waiting.stdout);
    // The command process has exited, so another command can run while approval waits.
    outputs.push((await run(["status", receipt.request])).stdout);
    expect(received?.env).toEqual({ SERVICE_TOKEN: "s1" });
    // Relative arguments resolve from the folder the crewmate's shell ran the command in.
    expect(received?.cwd).toBe(process.cwd());
    await owner.approve(receipt.request, "fixture-fresh-auth");
    const completed = await run(["status", receipt.request]);
    expect(decode(completed.stdout)).toMatchObject({
      receipt: { state: "completed", exitCode: 7 },
    });
    outputs.push(completed.stdout, (await run(args)).stdout);
    expect(executions).toBe(1);
    expect(captured).toBe("");
    const next = await run(args.map((arg) => (arg === "staging-1" ? "staging-2" : arg)));
    const cancelled = (decode(next.stdout) as { receipt: { request: string } }).receipt;
    outputs.push((await run(["cancel", cancelled.request])).stdout);
    await owner.approve(cancelled.request, "fixture-fresh-auth");
    expect(owner.status(cancelled.request)?.state).toBe("cancelled");
    expect(executions).toBe(1);
    expect(outputs.join("\n")).not.toContain(value);
    expect(outputs.join("\n")).not.toContain(Buffer.from(value).toString("base64"));
    for (const op of ["get", "approve", "export"]) expect((await run([op])).exitCode).not.toBe(0);
    expect((await run(["inject", "--unexpected"])).exitCode).toBe(2);
    for (const mapping of [
      '{"SERVICE_TOKEN":"s1","SERVICE_TOKEN":"s2"}',
      '{"SERVICE_TOKEN":"s1","SERVICE_\\u0054OKEN":"s2"}',
      '{"NODE_OPTIONS":"s1"}',
      '{"SERVICE_TOKEN":null}',
    ]) {
      const malformed = await run(args.map((arg, i) => (i === 2 ? mapping : arg)));
      expect(malformed.exitCode).toBe(2);
    }

    const unavailable = channel.grant("ordinary-unmigrated-task", {});
    expect((await shell(unavailable, [], {}, SECRETS_COMMAND)).stdout).toContain("NO_TOOL");
  });

  // Intent: INF-1690's plan, piece 3, the captain's answer "With the crew. Every
  // request is already checked before its card": the crew checks the exact run
  // from its own shell's folder, hears which check failed in the host's words,
  // and an inject that failed its checks says so instead of a bare refusal.
  it("pre-checks the exact run from the shell's folder and names the failed check", async () => {
    const channel = await openChannel();
    const checked: unknown[] = [];
    const owner = new SecretRequests({
      list: async () => [{ ref: "s1", label: "Disposable staging", version: "1" }],
      authenticate: async () => false,
      check: async (input) => {
        checked.push(input);
        return input.argv[0] === "./missing.sh"
          ? { problem: "program" }
          : { decision: "ask", program: "/bin/sh", files: [], folder: input.cwd ?? "" };
      },
      prepare: async () => undefined,
    });
    const grant = channel.grant("checked-secrets", { secrets: owner });
    const run = (args: string[]) => shell(grant, args, {}, SECRETS_COMMAND);
    const check = (program: string) =>
      run(["check", "--env", '{"SERVICE_TOKEN":"s1"}', "--", program]);
    const missing = await check("./missing.sh");
    expect(missing.exitCode).toBe(0);
    expect(decode(missing.stdout)).toEqual({
      check: { problem: "program" },
      help: SECRETS_CHECK_WORDS.problem.program,
    });
    expect(decode((await check("/bin/sh")).stdout)).toEqual({
      check: { decision: "ask", program: "/bin/sh", files: [], folder: process.cwd() },
      help: SECRETS_CHECK_WORDS.decision.ask,
    });
    expect(checked).toEqual([
      { env: { SERVICE_TOKEN: "s1" }, argv: ["./missing.sh"], cwd: process.cwd() },
      { env: { SERVICE_TOKEN: "s1" }, argv: ["/bin/sh"], cwd: process.cwd() },
    ]);
    // A check asks no one and keeps nothing: no request exists afterwards.
    expect(owner.receipts()).toEqual([]);
    expect((await run(["check", "--env", '{"NODE_OPTIONS":"s1"}', "--", "/bin/sh"])).exitCode).toBe(
      2,
    );
    const refused = await run([
      "inject",
      "--env",
      '{"SERVICE_TOKEN":"s1"}',
      "--reason",
      "Check staging",
      "--id",
      "staging-1",
      "--",
      "./missing.sh",
    ]);
    expect(decode(refused.stdout)).toMatchObject({
      receipt: { state: "unavailable" },
      help: SECRETS_CHECK_WORDS.refused,
    });
  });

  it("gives a task on another computer the catalog alone: list and show answer, every use is unavailable", async () => {
    // INF-1109's revision spec: "Treat all crewmates consistently ... send metadata only. Do not
    // move values, grant remote execution or construct production custody as a shortcut."
    const channel = await openChannel();
    const staging = {
      ref: "staging-db",
      label: "Staging database password",
      version: "2",
      environment: "Staging",
    };
    let lists = 0;
    const grant = channel.grant("placed-secrets", {
      secretsCatalog: {
        list: async () => {
          lists++;
          return [staging];
        },
      },
    });
    const run = (args: string[]) => shell(grant, args, {}, SECRETS_COMMAND);
    expect(decode((await run(["list"])).stdout)).toEqual({ secrets: [staging], requests: [] });
    expect(decode((await run(["show", "staging-db"])).stdout)).toEqual({ secret: staging });
    expect(lists).toBe(2);
    const inject = await run([
      "inject",
      "--env",
      '{"DATABASE_PASSWORD":"staging-db"}',
      "--reason",
      "Run the staging migration",
      "--id",
      "migrate-staging",
      "--",
      "/bin/sh",
      "./scripts/migrate.sh",
    ]);
    expect(decode(inject.stdout)).toEqual({ unavailable: true, help: SECRETS_ELSEWHERE_HELP });
    for (const op of ["status", "cancel"]) {
      expect(decode((await run([op, "migrate-staging"])).stdout)).toEqual({
        unavailable: true,
        help: SECRETS_ELSEWHERE_HELP,
      });
    }
    // A use never even read the catalog: nothing past the list is reachable from there.
    expect(lists).toBe(2);
  });
});
