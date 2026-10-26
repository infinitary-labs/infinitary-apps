import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserAnswer } from "../browser/taskBrowsers";
import {
  BROWSER_COMMANDS,
  BROWSER_RULES,
  type BrowserConnection,
  browserAxi,
} from "./browserCommands";
import { runTaskAxiCli } from "./cli";
import type { BrowserReply } from "./protocol";

/**
 * infinitary-browser-axi's command table against a stand-in for the task's
 * channel: which browser operation each command asks for, which arguments
 * it refuses before asking anything, and what it prints - the page's
 * aggregates first, the outline as the browser wrote it, explicit empty
 * lists, errors with their exit codes, and a kept answer's words.
 */

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

const PAGE: BrowserAnswer = {
  text: "Page: ...",
  page: {
    title: "Sign up",
    url: "http://127.0.0.1:5555/",
    refs: "g3",
    controls: 2,
    errors: 1,
    did: 'Clicked button "Send" [g3:e2]. The page did not move.',
  },
  body: 'The page logged errors:\n- boom\n\noutline: lines 1-2 of 2\nheading "Sign up" (level 1)\n  textbox "Name" [g3:e1]',
  next: ["`infinitary-browser-axi snapshot --from 3` reads on from line 3"],
};

function connection(
  reply: (op: string) => BrowserReply = () => ({ kind: "answer", answer: PAGE }),
) {
  const calls: { command: string; op: string; input: unknown }[] = [];
  const browser: BrowserConnection = {
    call: async (command, op, input) => {
      calls.push({ command, op, input });
      return reply(op);
    },
  };
  return { calls, browser };
}

async function run(argv: string[], reply?: (op: string) => BrowserReply) {
  const { calls, browser } = connection(reply);
  process.exitCode = 0;
  let stdout = "";
  await runTaskAxiCli(
    browserAxi("1.0.0", async () => browser),
    argv,
    {
      write: (chunk) => {
        stdout += chunk;
      },
    },
  );
  return { stdout, exitCode: process.exitCode ?? 0, calls };
}

describe("infinitary-browser-axi's commands", () => {
  it.for([
    [["open", "http://127.0.0.1:5555/"], "navigate", { url: "http://127.0.0.1:5555/" }],
    [["back"], "navigate", { go: "back" }],
    [["forward"], "navigate", { go: "forward" }],
    [["reload"], "navigate", { go: "reload" }],
    [["snapshot"], "inspect", {}],
    [["snapshot", "--from", "41"], "inspect", { from: 41 }],
    [
      ["snapshot", "--find", "Release 11", "--from", "9"],
      "inspect",
      { find: "Release 11", from: 9 },
    ],
    [["snapshot", "--full"], "inspect", { full: true }],
    [["snapshot", "@g3:e5"], "inspect", { ref: "g3:e5" }],
    [["wait", "Booking", "confirmed"], "inspect", { waitFor: "Booking confirmed" }],
    [["click", "@g3:e2"], "act", { action: "click", ref: "g3:e2" }],
    [["click", "[g3:e2]"], "act", { action: "click", ref: "g3:e2" }],
    [["hover", "g3:e4"], "act", { action: "hover", ref: "g3:e4" }],
    [["drag", "@g3:e1", "@g3:e9"], "act", { action: "drag", ref: "g3:e1", to: "g3:e9" }],
    [["fill", "@g3:e1", "Sam", "Lee"], "act", { action: "set", ref: "g3:e1", text: "Sam Lee" }],
    [["fill", "@g3:e1", ""], "act", { action: "set", ref: "g3:e1", text: "" }],
    [
      ["fillform", "@g3:e1=Ada Lovelace", "@g3:e2=a=b", "@g3:e3="],
      "act",
      {
        action: "fill",
        fields: [
          { ref: "g3:e1", text: "Ada Lovelace" },
          { ref: "g3:e2", text: "a=b" },
          { ref: "g3:e3", text: "" },
        ],
      },
    ],
    [
      ["upload", "docs/certificate.pdf", "scan.png"],
      "act",
      { action: "upload", files: ["docs/certificate.pdf", "scan.png"] },
    ],
    [["press", "enter", "@g3:e1"], "act", { action: "press", key: "Enter", ref: "g3:e1" }],
    [["press", "Tab"], "act", { action: "press", key: "Tab" }],
    [["scroll", "bottom"], "act", { action: "scroll", direction: "bottom" }],
    [["scroll", "@g3:e9"], "act", { action: "scroll", ref: "g3:e9" }],
    [
      ["screenshot", "after-send", "--full-page", "--reason", "The booking reference"],
      "capture",
      { name: "after-send", fullPage: true, reason: "The booking reference" },
    ],
    [["screenshot", "--uid", "@g3:e4"], "capture", { ref: "g3:e4" }],
    [["pages"], "pages", {}],
    [["selectpage", "2"], "navigate", { page: 2 }],
    [["closepage", "2"], "close", { page: 2 }],
    [["console"], "inspect", { show: "console" }],
    [["network"], "inspect", { show: "network" }],
    [["stop"], "close", {}],
  ] as const)("%j asks the task browser for %s", async ([argv, op, input]) => {
    const answer = await run([...argv]);
    expect(answer.exitCode).toBe(0);
    expect(answer.calls).toEqual([{ command: argv[0], op, input }]);
  });

  it.for([
    ["open"],
    ["click"],
    ["click", "e5"],
    ["drag", "@g3:e1"],
    ["fill", "@g3:e1"],
    ["fillform", "@g3:e1"],
    ["upload"],
    ["press", "Explode"],
    ["scroll", "sideways"],
    ["scroll"],
    ["selectpage", "0"],
    ["closepage", "two"],
    ["snapshot", "@g3:e5", "--full"],
    ["snapshot", "--from", "zero"],
    ["snapshot", "--find", "x", "--full"],
    ["screenshot", "--uid", "@g3:e1", "--full-page"],
    ["wait"],
    ["back", "now"],
  ])("refuses %j with exit 2 before asking the browser anything", async (argv) => {
    const answer = await run(argv);
    expect(answer.exitCode).toBe(2);
    expect(decode(answer.stdout)).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(answer.calls).toEqual([]);
  });

  // The approved design (rev-10), with the captain's choice on INF-1454 that a
  // crewmate attaches a file a page asked for from its own working copy.
  it("offers exactly the approved commands, and nothing that runs script, answers a dialog, emulates, profiles or updates", async () => {
    expect(Object.keys(BROWSER_COMMANDS).sort()).toEqual(
      [
        "back",
        "click",
        "closepage",
        "console",
        "drag",
        "fill",
        "fillform",
        "forward",
        "hover",
        "network",
        "open",
        "pages",
        "press",
        "reload",
        "screenshot",
        "scroll",
        "selectpage",
        "snapshot",
        "stop",
        "upload",
        "wait",
      ].sort(),
    );
    for (const name of [
      "eval",
      "run",
      "emulate",
      "lighthouse",
      "perf-start",
      "heap",
      "dialog",
      "update",
      "setup",
      "newpage",
      "type",
    ]) {
      const answer = await run([name]);
      expect(answer.exitCode, name).toBe(2);
      expect(answer.calls, name).toEqual([]);
    }
  });

  it("prints a page's aggregates first, then the outline as the browser wrote it, then how to read on", async () => {
    const answer = await run(["click", "@g3:e2"]);
    const [head, ...rest] = answer.stdout.split("\nThe page logged errors:");
    expect(decode(head ?? "")).toEqual({
      page: { title: "Sign up", url: "http://127.0.0.1:5555/", refs: "g3", controls: 2, errors: 1 },
      did: 'Clicked button "Send" [g3:e2]. The page did not move.',
    });
    expect(rest.join("")).toContain(
      'outline: lines 1-2 of 2\nheading "Sign up" (level 1)\n  textbox "Name" [g3:e1]',
    );
    expect(answer.stdout.trimEnd().split("\n").at(-1)).toBe(
      "help[1]: `infinitary-browser-axi snapshot --from 3` reads on from line 3",
    );
  });

  it("carries the sign-in rule where a page opens, and the signed-in rule on every answer from a browser that may show the captain's account", async () => {
    const opened = await run(["open", "https://shop.example/"]);
    expect(opened.stdout).toContain(BROWSER_RULES.signIn);
    const clicked = await run(["click", "@g3:e2"]);
    expect(clicked.stdout).not.toContain(BROWSER_RULES.signIn);
    expect(clicked.stdout).not.toContain(BROWSER_RULES.signedIn);
    const signedIn: BrowserAnswer = {
      ...PAGE,
      page: { ...(PAGE.page as NonNullable<BrowserAnswer["page"]>), signedIn: true },
    };
    const read = await run(["snapshot"], () => ({ kind: "answer", answer: signedIn }));
    expect(read.stdout).toContain(BROWSER_RULES.signedIn);
    // The payment rule rides the help of each command that presses.
    expect((await run(["click", "--help"])).stdout).toContain(BROWSER_RULES.payment);
    expect((await run(["press", "--help"])).stdout).toContain(BROWSER_RULES.payment);
  });

  it("lists pages, console and network as compact rows, and says so when a list is empty", async () => {
    const pages = await run(["pages"], () => ({
      kind: "answer",
      answer: {
        text: "Two pages are open.",
        pages: [
          { place: 1, title: "Shop", url: "https://shop.example/pay", current: false },
          { place: 2, title: "Bank check", url: "https://bank.example/", current: true },
        ],
      },
    }));
    expect(decode(pages.stdout)).toMatchObject({
      pages: [
        { page: 1, title: "Shop", url: "https://shop.example/pay", current: false },
        { page: 2, title: "Bank check", url: "https://bank.example/", current: true },
      ],
    });
    const quiet = await run(["console"], () => ({
      kind: "answer",
      answer: {
        ...PAGE,
        body: "",
        next: [],
        diagnostics: { show: "console", total: 0, counts: {}, rows: [] },
      },
    }));
    expect(quiet.stdout).toContain("console:\n  messages: 0");
    expect(quiet.stdout).toContain("rows: 0 messages");
    const hidden = await run(["console"], () => ({
      kind: "answer",
      answer: {
        ...PAGE,
        body: "",
        next: [],
        diagnostics: { show: "console", total: 3, counts: { error: 3 } },
      },
    }));
    expect(hidden.stdout).toContain("levels: error 3");
    expect(hidden.stdout).toContain("only counts are passed on");
    const network = await run(["network"], () => ({
      kind: "answer",
      answer: {
        ...PAGE,
        body: "",
        next: [],
        diagnostics: {
          show: "network",
          total: 1,
          rows: [
            { method: "GET", url: "https://shop.example/api", type: "Fetch", result: "status 200" },
          ],
        },
      },
    }));
    expect(network.stdout).toContain(
      'rows[1]{method,url,type,result}:\n  GET,"https://shop.example/api",Fetch,status 200',
    );
  });

  it("prints a picture's path for the read tool, never its bytes", async () => {
    const answer = await run(["screenshot", "after"], () => ({
      kind: "answer",
      answer: {
        ...PAGE,
        body: "",
        next: [],
        picture: {
          path: "/evidence/after.png",
          width: 1280,
          height: 800,
          what: "the visible page",
        },
      },
    }));
    expect(answer.stdout).toContain("picture: /evidence/after.png");
    expect(answer.stdout).toContain("Open the picture with your read tool to see it");
    expect(answer.stdout).not.toContain("AAAA");
  });

  it("prints the browser's refusal as an error with exit 1, and a malformed ask it refused with exit 2", async () => {
    const refused = await run(["click", "@g2:e1"], () => ({
      kind: "answer",
      answer: {
        text: "g2:e1 is from a page this browser showed before it moved.",
        refused: "refused",
      },
    }));
    expect(refused.exitCode).toBe(1);
    expect(decode(refused.stdout)).toEqual({
      error: "g2:e1 is from a page this browser showed before it moved.",
      code: "REFUSED",
    });
    const invalid = await run(["click", "@g2:e1"], () => ({
      kind: "answer",
      answer: { text: "click needs the ref of what to click.", refused: "invalid" },
    }));
    expect(invalid.exitCode).toBe(2);
  });

  it("says a command past the shell's limit still runs, hands its answer to the next command, and never runs that one", async () => {
    const running = await run(["click", "@g3:e2"], () => ({ kind: "running", command: "click" }));
    expect(running.exitCode).toBe(0);
    expect(decode(running.stdout)).toMatchObject({ running: "click" });
    expect(running.stdout).toContain("Never run click again for it");

    const earlier = await run(["snapshot"], () => ({
      kind: "earlier",
      command: "click",
      answer: PAGE,
    }));
    expect(earlier.exitCode).toBe(0);
    expect(earlier.stdout).toContain(
      'earlier: "Your earlier click finished, so this snapshot was not run; run it again if you still need it"',
    );
    expect(earlier.stdout).toContain(
      'did: "Clicked button \\"Send\\" [g3:e2]. The page did not move."',
    );

    const busy = await run(["snapshot"], () => ({ kind: "busy", command: "click" }));
    expect(busy.exitCode).toBe(1);
    expect(decode(busy.stdout)).toMatchObject({ code: "BUSY" });
  });

  it("shows content first at home: the page with how to use it, or that none is open and how to open one", async () => {
    const open = await run([]);
    expect(open.exitCode).toBe(0);
    expect(open.stdout).toMatch(/^bin: /);
    expect(open.stdout).toContain("description: ");
    expect(open.stdout).toContain("title: Sign up");
    expect(open.calls).toEqual([{ command: "snapshot", op: "inspect", input: {} }]);
    expect(open.stdout).toContain(BROWSER_RULES.payment);

    const none = await run([], () => ({
      kind: "answer",
      answer: {
        text: "No browser is open for this task. Run `infinitary-browser-axi open <url>` to open one.",
        refused: "refused",
      },
    }));
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toContain("browser: No browser is open for this task.");
    expect(none.stdout).toContain("`infinitary-browser-axi open <url>` opens a page");
  });
});
