import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type FakePage,
  formNodes,
  harness,
  PICTURE,
} from "../../../tests/helpers/taskBrowserStandIn";
import type { HostLoadOutcome } from "../host";
import type { BrowserNode } from "./outline";

/**
 * Each task's own browser, against the stand-in host whose page records every
 * effect it is asked for (tests/helpers/taskBrowserStandIn.ts): the browser
 * actions a crewmate takes on a page: its actions, a page that asks for a file
 * and downloads. The host's real page is the desktop's
 * (src/main/host/taskBrowser.ts), driven end to end by the task browser
 * journeys (tests/e2e/task-browser*.spec.ts).
 */

describe("piece 4 browser actions", () => {
  it("hovers, drags, fills text without submitting, and scrolls to either edge", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    await browser.act({ action: "hover", ref: "g1:e3" });
    await browser.act({ action: "drag", ref: "g1:e1", to: "g1:e3" });
    await browser.act({ action: "fill", fields: [{ ref: "g1:e1", text: "Ada" }] });
    await browser.act({ action: "fill", fields: [{ ref: "g1:e1", text: "" }] });
    await browser.act({ action: "scroll", direction: "top" });
    await browser.act({ action: "scroll", direction: "bottom" });
    expect(page.effects).toEqual(
      expect.arrayContaining([
        "hover 40,315",
        "drag 12 30",
        "insert Ada",
        "press Backspace",
        "scroll top",
        "scroll bottom",
      ]),
    );
    expect(page.effects).not.toContain("press Enter");
    const fact = browsers.fact("t1");
    expect(fact?.state === "open" ? fact.did : undefined).not.toContain("Ada");
  });

  it("refuses stale destinations and later fields before any input, plus non-text fields", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    const before = [...page.effects];
    expect((await browser.act({ action: "drag", ref: "g1:e1", to: "g9:e1" })).text).toContain(
      "ref",
    );
    expect(
      (
        await browser.act({
          action: "fill",
          fields: [
            { ref: "g1:e1", text: "Ada" },
            { ref: "g9:e1", text: "bad" },
          ],
        })
      ).text,
    ).toContain("ref");
    expect(
      (await browser.act({ action: "fill", fields: [{ ref: "g1:e3", text: "bad" }] })).text,
    ).toContain("not an editable text field");
    expect(page.effects).toEqual(before);
    expect((await browser.capture({ ref: "g9:e1" })).image).toBeUndefined();
    expect(page.effects).toEqual(before);
  });

  it("stops a multi-field fill after a move rather than using old targets", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    page.insertText = async (text) => {
      page.effects.push(`insert ${text}`);
      page.current = "http://localhost:5173/next";
      page.opened.onNavigated(page.current);
    };
    const result = await browser.act({
      action: "fill",
      fields: [
        { ref: "g1:e1", text: "first" },
        { ref: "g1:e1", text: "second" },
      ],
    });
    expect(result.text).toContain("Stopped after filling 1 fields");
    expect(page.effects).not.toContain("insert second");
  });

  it("captures an element but keeps whole-page privacy and captain-control guards", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    expect((await browser.capture({ ref: "g1:e3" })).image).toEqual(PICTURE);
    expect(page.effects).toContain("capture target 30");
    expect((await browser.capture({ ref: "g1:e3", fullPage: true })).image).toBeUndefined();
    const handle = { session: browsers.session, generation: 1 };
    await browsers.takeControl("t1", handle);
    const before = [...page.effects];
    for (const input of [
      { action: "hover" as const, ref: "g1:e3" },
      { action: "drag" as const, ref: "g1:e1", to: "g1:e3" },
      { action: "fill" as const, fields: [{ ref: "g1:e1", text: "Ada" }] },
      { action: "scroll" as const, direction: "bottom" as const },
    ])
      expect((await browser.act(input)).text).toContain("captain");
    expect((await browser.capture({ ref: "g1:e3" })).image).toBeUndefined();
    expect(page.effects).toEqual(before);
    await browsers.returnControl("t1", handle);
    page.nodeList = formNodes().map((node) =>
      node.role === "textbox" ? { ...node, value: "private" } : node,
    );
    await browser.inspect({});
    expect((await browser.capture({ ref: "g2:e3" })).text).toContain("reason");
    const refused = await browser.capture({ ref: "g2:e3", reason: "Need the button" });
    expect(refused.image).toBeUndefined();
    expect(refused.text).not.toContain("private");
    expect(refused.text).toContain("holds text you did not type");
    expect(page.effects.filter((effect) => effect.startsWith("capture"))).toEqual([
      "capture target 30",
    ]);
  });
});

// The captain's words (INF-1454): "shouldn't task browser be invisible on my
// desktop?" A page's file request goes to no picker on the page's hidden
// window: the captain's own pick when they hold it, and otherwise, by their
// choice, a file the crewmate attaches from its own working copy.
describe('a frame on the page (docs/task-browser.md, "Frames")', () => {
  /**
   * The stand-in sign-up form with a sign-in check from Cloudflare in a
   * frame of its own, its checkbox numbered as the host numbers an element
   * inside a frame from another site.
   */
  function withCheck(page: FakePage): void {
    const nodes = formNodes();
    const root = nodes[0] as BrowserNode;
    root.childIds = [...root.childIds, "6"];
    nodes.push(
      {
        id: "6",
        role: "Iframe",
        name: "Widget containing a Cloudflare security challenge",
        ignored: false,
        childIds: ["7"],
        target: 40,
        frameUrl: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile",
        properties: {},
      },
      {
        id: "7",
        role: "RootWebArea",
        name: "",
        ignored: false,
        childIds: ["8"],
        properties: {},
      },
      {
        id: "8",
        role: "checkbox",
        name: "Verify you are human",
        ignored: false,
        childIds: [],
        target: 2 ** 31 + 9,
        properties: { checked: "false" },
      },
    );
    page.nodeList = nodes;
    page.boxes.set(2 ** 31 + 9, { x: 600, y: 300, width: 20, height: 20 });
  }

  it("reads a human check's frame and never lets the crewmate answer it", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173" });
    const page = pages[0] as FakePage;
    withCheck(page);
    const look = (await browser.inspect({})).text;
    expect(look).toContain(
      'frame "Widget containing a Cloudflare security challenge" from challenges.cloudflare.com: a human check, which only the captain answers',
    );
    expect(look).toContain('checkbox "Verify you are human" [g1:e4] (not checked)');
    const before = [...page.effects];
    for (const input of [
      { action: "click", ref: "g1:e4" },
      { action: "hover", ref: "g1:e4" },
      { action: "drag", ref: "g1:e1", to: "g1:e4" },
    ] as const) {
      expect((await browser.act(input)).text).toBe(
        'checkbox "Verify you are human" [g1:e4] is in a human check from challenges.cloudflare.com, which only the captain answers: ask the captain on a card with emit_card browser_handoff.',
      );
    }
    expect(page.effects).toEqual(before);
    await browser.act({ action: "click", ref: "g1:e3" });
    expect(page.effects.length).toBeGreaterThan(before.length);
  });
});

describe("a page that asks for a file", () => {
  /** A working copy with a file to attach, and a file outside it a link leads to. */
  function workingCopy(): { root: string; outside: string } {
    const dir = scratchDir("infinitary-browser-files-");
    const root = join(dir, "work");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "certificate.pdf"), "%PDF-1.4");
    writeFileSync(join(root, ".git", "config"), "[core]");
    const outside = join(dir, "private.txt");
    writeFileSync(outside, "not the task's");
    symlinkSync(outside, join(root, "link.txt"));
    return { root, outside };
  }

  it("tells the crewmate, which attaches a file from its working copy and nothing outside it", async () => {
    const { root, outside } = workingCopy();
    const h = harness({ workingCopy: root });
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    expect(
      (await browser.act({ action: "upload", files: ["docs/certificate.pdf"] })).text,
    ).toContain("has not asked for a file");
    page.opened.onFileChooser({ target: 40, multiple: false });
    expect((await browser.inspect({})).text).toContain("The page asks for a file");
    for (const file of [outside, "link.txt", "../private.txt", ".git/config"]) {
      expect((await browser.act({ action: "upload", files: [file] })).text).toContain(
        "not in your working copy",
      );
    }
    expect((await browser.act({ action: "upload", files: ["docs"] })).text).toContain(
      "is not a file in your working copy",
    );
    expect(
      (
        await browser.act({
          action: "upload",
          files: ["docs/certificate.pdf", "docs/certificate.pdf"],
        })
      ).text,
    ).toContain("takes one file");
    expect(page.effects.filter((effect) => effect.startsWith("files"))).toEqual([]);
    const attached = await browser.act({ action: "upload", files: ["docs/certificate.pdf"] });
    expect(attached.text).toContain('Attached "certificate.pdf"');
    expect(attached.text).not.toContain("The page asks for a file");
    expect(page.effects.filter((effect) => effect.startsWith("files"))).toEqual([
      `files 40 ${realpathSync(join(root, "docs", "certificate.pdf"))}`,
    ]);
    // A request the page moved away from is gone with its document.
    page.opened.onFileChooser({ target: 41, multiple: true });
    page.opened.onNavigated("http://localhost:5173/next");
    expect(
      (await browser.act({ action: "upload", files: ["docs/certificate.pdf"] })).text,
    ).toContain("has not asked for a file");
  });

  it("opens the app's own picker for the captain, and the crewmate is told nothing of it", async () => {
    const picks: boolean[] = [];
    const h = harness({
      chooseFiles: async ({ multiple }) => {
        picks.push(multiple);
        return ["/Users/captain/receipt.pdf", "/Users/captain/other.pdf"];
      },
    });
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    page.opened.onFileChooser({ target: 40, multiple: false });
    await expect
      .poll(() => page.effects.filter((effect) => effect.startsWith("files")))
      .toEqual(["files 40 /Users/captain/receipt.pdf"]);
    expect(picks).toEqual([false]);
    await h.browsers.returnControl("t1", handle);
    expect((await browser.inspect({})).text).not.toContain("asks for a file");
  });

  it("leaves a request on another computer's browser to the crewmate, and says so on the record", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    page.opened.onFileChooser({ target: 40, multiple: false });
    expect(h.notes.some((note) => note.includes("its page asked for a file"))).toBe(true);
    await h.browsers.returnControl("t1", handle);
    expect((await browser.inspect({})).text).toContain("The page asks for a file");
  });

  it("tells the crewmate a page asked to print or opened a color picker, which never open", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = h.pages[0] as FakePage;
    page.opened.onPicker("print");
    page.opened.onPicker("color");
    const text = (await browser.inspect({})).text;
    expect(text).toContain("this browser never prints");
    expect(text).toContain("color picker: this browser never shows one");
  });
});

// The captain's pick on INF-2442's card, "Attachments, downloads, large
// recordings and the other Mac's record reach the hand-over folder", and
// INF-1734's goal: a file the task's browser downloads, such as an IRS
// letter, lands where the crewmate can read it and hand it on.
describe('a page downloads a file (docs/task-browser.md, "A download")', () => {
  function hostSaves(page: FakePage, url: string, name: string, content: string) {
    const target = page.opened.onDownload({ url, name, bytes: content.length });
    if (!target) throw new Error("the core refused the download");
    writeFileSync(target.path, content);
    target.done({ state: "completed", bytes: content.length });
    return target.path;
  }

  it("saves it in the evidence folder under its own name, never over another, and tells the crewmate", async () => {
    const { browsers, pages, notes, evidence } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const letter = "%PDF-1.7 Notice CP2000 for tax year 2025";
    const first = hostSaves(
      page,
      "https://www.irs.gov/pub/notices/cp2000.pdf",
      "cp2000.pdf",
      letter,
    );
    const second = hostSaves(
      page,
      "https://www.irs.gov/pub/notices/cp2000.pdf",
      "cp2000.pdf",
      "%PDF-1.7 a second copy",
    );
    const dir = join(evidence, "t1", "downloads");
    expect(first).toBe(join(dir, "cp2000.pdf"));
    expect(second).toBe(join(dir, "cp2000-2.pdf"));
    expect(readFileSync(first, "utf8")).toBe(letter);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    const answer = await browser.inspect({});
    expect(answer.text).toContain("The browser downloaded files into the task's evidence folder");
    expect(answer.text).toContain(`- ${first} (${letter.length} bytes, from www.irs.gov)`);
    expect(answer.text).toContain(`- ${second} (`);
    expect(notes).toContain("t1: its browser downloaded cp2000.pdf from www.irs.gov");
    expect((await browser.inspect({})).text).not.toContain("downloaded files");
  });

  it("keeps a site's name inside the folder, and keeps nothing of a download that did not finish", async () => {
    const { browsers, pages, evidence } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const dir = join(evidence, "t1", "downloads");
    const escaping = page.opened.onDownload({
      url: "http://localhost:5173/export",
      name: "../../.ssh/authorized_keys",
      bytes: 0,
    });
    expect(escaping?.path).toBe(join(dir, "authorized_keys"));
    const nameless = page.opened.onDownload({
      url: "blob:http://localhost:5173/9f2c",
      name: "",
      bytes: 0,
    });
    expect(nameless?.path).toBe(join(dir, "download"));
    const running = await browser.inspect({});
    expect(running.text).toContain('Still downloading: "../../.ssh/authorized_keys", "".');
    escaping?.done({ state: "interrupted", bytes: 512 });
    expect(existsSync(join(dir, "authorized_keys"))).toBe(false);
    const after = await browser.inspect({});
    expect(after.text).toContain(
      '"../../.ssh/authorized_keys" from localhost:5173 did not finish downloading (interrupted); nothing was kept.',
    );
    expect(after.text).toContain('Still downloading: "".');
  });

  it("says where an unfinished download's partial file is still kept when it could not be removed", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    const target = page.opened.onDownload({
      url: "http://localhost:5173/export.csv",
      name: "export.csv",
      bytes: 0,
    });
    if (!target) throw new Error("the core refused the download");
    // A folder at the file's path stops the removal on every system and for
    // every account, where a read-only folder stops neither Windows nor root.
    rmSync(target.path);
    mkdirSync(target.path);
    writeFileSync(join(target.path, "part"), "date,total\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      target.done({ state: "interrupted", bytes: 11 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[task-browser] could not remove an unfinished download"),
      );
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(join(target.path, "part"))).toBe(true);
    const after = await browser.inspect({});
    expect(after.text).toContain(
      `"export.csv" from localhost:5173 did not finish downloading (interrupted); its partial file could not be removed and is still at ${target.path}.`,
    );
    expect(after.text).not.toContain("nothing was kept");
  });

  it("tells the crewmate of a file the captain downloaded while holding the page", async () => {
    const h = harness();
    const browser = h.browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const handle = { session: h.browsers.session, generation: 1 };
    await h.browsers.takeControl("t1", handle);
    const path = hostSaves(
      h.pages[0] as FakePage,
      "https://bank.example/statement",
      "statement-october.pdf",
      "%PDF-1.4 statement",
    );
    await h.browsers.returnControl("t1", handle);
    expect((await browser.inspect({})).text).toContain(`- ${path} (`);
  });

  it("answers an address that is a file with the download, not a replaced load", async () => {
    const { browsers, pages } = harness();
    const browser = browsers.forTask("t1");
    await browser.navigate({ url: "http://localhost:5173/" });
    const page = pages[0] as FakePage;
    page.pendingLoad = (async () => {
      hostSaves(
        page,
        "http://localhost:5173/report.csv",
        "report.csv",
        "date,total\n2026-11-02,4\n",
      );
      return { ok: false, code: "ERR_FAILED" } as HostLoadOutcome;
    })();
    const answer = await browser.navigate({ url: "http://localhost:5173/report.csv" });
    expect(answer.text).toContain("That address is a file to download, not a page");
    expect(answer.text).toContain("downloads/report.csv (");
  });
});
