import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BrowserAnswer, CrewmateBrowser } from "../browser/taskBrowsers";
import { forkChildProcess } from "../sql/forkChildProcess";
import { BROWSER_COMMANDS } from "./browserCommands";
import { AxiChannel, SHELL_CAP_ENV, type TaskShell } from "./channel";

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

async function openChannel(keysDir = join(scratchDir("infinitary-axi-channel-"), "task-channel")) {
  const channel = await AxiChannel.open({
    spawner: forkChildProcess(entry),
    binDir: BIN_DIR,
    version: "9.9.9-test",
    keysDir,
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
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: [...(granted?.path ?? [BIN_DIR]), process.env.PATH ?? ""].join(":"),
    HOME: process.env.HOME,
    ...(granted?.env ?? {}),
    ...extra,
  };
  return new Promise((done) => {
    execFile(
      "/bin/sh",
      ["-c", 'infinitary-browser-axi "$@"', "sh", ...args],
      { env },
      (error, stdout) => {
        const exitCode = error ? Number((error as { code?: number }).code ?? 1) : 0;
        done({ stdout, exitCode });
      },
    );
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
});
