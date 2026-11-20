import { describe, expect, it } from "vitest";
import { type FakePage, harness } from "../../../tests/helpers/taskBrowserStandIn";
import { KEY_HIDDEN } from "../keyFormats";
import { KEYS_HIDDEN_WORDS } from "./crewmateCommands";
import type { BrowserNode } from "./outline";

/**
 * A key the page shows after the captain handed the browser back, such as
 * one he just made on a provider's site, never reaches the crewmate in a
 * known format (docs/task-browser.md, "A signed-in page"), against the
 * stand-in host (tests/helpers/taskBrowserStandIn.ts).
 */

/** An invented key in GitHub's personal token format, built here so no file holds one whole. */
const KEY = ["github", "pat", "11FIXTURE0INVENTED0NOT0A0KEY0000000"].join("_");

/** The page a provider shows once a key is made: a line with the key and a button that names it. */
function keyNodes(): BrowserNode[] {
  return [
    {
      id: "1",
      role: "RootWebArea",
      name: "New token",
      ignored: false,
      // 5 and 6 are a list and a link a test adds; the outline skips an id it is not given.
      childIds: ["2", "3", "4", "5", "6"],
      properties: {},
    },
    {
      id: "2",
      role: "heading",
      name: "New token",
      ignored: false,
      childIds: [],
      properties: { level: 1 },
    },
    {
      id: "3",
      role: "StaticText",
      name: `Your key: ${KEY}`,
      ignored: false,
      childIds: [],
      properties: {},
    },
    {
      id: "4",
      role: "button",
      name: `Copy ${KEY}`,
      ignored: false,
      childIds: [],
      target: 41,
      properties: { description: `Copies ${KEY}` },
    },
  ];
}

/** The page shows a new key; with `handBack` the captain held the browser while it appeared. */
async function shownKey(handBack = true) {
  const h = harness();
  const browser = h.browsers.forTask("t1");
  await browser.navigate({ url: "https://keys.example/" });
  const page = h.pages[0] as FakePage;
  const handle = { session: h.browsers.session, generation: 1 };
  if (handBack) await h.browsers.takeControl("t1", handle);
  page.nodeList = keyNodes();
  page.boxes.set(41, { x: 10, y: 300, width: 60, height: 30 });
  page.pageTitle = `Token ${KEY}`;
  page.current = `https://keys.example/tokens/${KEY}?tab=new`;
  if (handBack) await h.browsers.returnControl("t1", handle);
  return { ...h, browser, page, handle };
}

describe('a key the page shows after a handback (docs/task-browser.md, "A signed-in page")', () => {
  it("reads a text line with the key hidden in place, and says why", async () => {
    const { browser } = await shownKey();
    const read = await browser.inspect({});
    expect(read.text).toContain(`text "Your key: ${KEY_HIDDEN}"`);
    expect(read.text).toContain(KEYS_HIDDEN_WORDS);
    expect(read.text).not.toContain(KEY);
  });

  it("reads a control's name and description with the key hidden, and its ref still works", async () => {
    const { browser, page } = await shownKey();
    const read = await browser.inspect({});
    const ref = /button "Copy \[key hidden\]" \[(g\d+:e\d+)\]/.exec(read.text)?.[1];
    expect(ref).toBeDefined();
    const clicked = await browser.act({ action: "click", ref: ref as string });
    expect(page.effects).toContain("click 40,315");
    expect(clicked.text).toContain(`Clicked button "Copy ${KEY_HIDDEN}"`);
    expect(clicked.text).not.toContain(KEY);
  });

  it("reads a full passage with the key hidden", async () => {
    const { browser } = await shownKey();
    const read = await browser.inspect({});
    const ref = /\[(g\d+:e\d+)\]/.exec(read.text)?.[1] as string;
    const passage = await browser.inspect({ ref });
    expect(passage.text).toContain(`Full text of button "Copy ${KEY_HIDDEN}"`);
    expect(passage.text).toContain(`title: "Copies ${KEY_HIDDEN}"`);
    expect(passage.text).not.toContain(KEY);
  });

  it("never finds the key in a search", async () => {
    const { browser } = await shownKey();
    const found = await browser.inspect({ find: KEY });
    // Only the crewmate's own words name it, in saying no line holds them.
    expect(found.text).toContain(`No line holds ${JSON.stringify(KEY)}.`);
    expect(found.text.replace(JSON.stringify(KEY), "")).not.toContain(KEY);
  });

  it("never sees the key appear in a wait", async () => {
    const { browser } = await shownKey();
    const waited = await browser.inspect({ waitFor: KEY.slice(0, 20) });
    expect(waited.text).toContain("did not appear");
    expect(waited.page?.title).not.toContain(KEY);
  });

  it("reads the page title and address with the key hidden, in every answer that names them", async () => {
    const { browser } = await shownKey();
    const read = await browser.inspect({});
    expect(read.page?.title).toBe(`Token ${KEY_HIDDEN}`);
    expect(read.page?.url).toBe(`https://keys.example/tokens/${KEY_HIDDEN}`);
    const pages = await browser.pages();
    expect(pages.pages?.[0]).toMatchObject({
      title: `Token ${KEY_HIDDEN}`,
      url: `https://keys.example/tokens/${KEY_HIDDEN}`,
    });
    expect(`${read.text}\n${pages.text}`).not.toContain(KEY);
  });

  it("reads a dialog's message with the key hidden", async () => {
    const { browser, page } = await shownKey();
    page.opened.onDialog("alert", `Copied ${KEY}`);
    const read = await browser.inspect({});
    expect(read.text).toContain(`alert "Copied ${KEY_HIDDEN}"`);
    expect(read.text).not.toContain(KEY);
  });

  it("takes no picture of a page that shows a key, of an element neither", async () => {
    const { browser, page } = await shownKey();
    const read = await browser.inspect({});
    const ref = /\[(g\d+:e\d+)\]/.exec(read.text)?.[1] as string;
    for (const ask of [{}, { fullPage: true }, { ref }]) {
      const shot = await browser.capture({ ...ask, reason: "show the token page" });
      expect(shot.refused).toBe("refused");
      expect(shot.text).toContain("Did not photograph the page: it shows a key");
      expect(shot.image).toBeUndefined();
    }
    expect(page.effects.some((effect) => effect.startsWith("capture"))).toBe(false);
  });

  it("names a list's options with the key hidden when a choice matches none", async () => {
    const { browser, page } = await shownKey();
    page.nodeList.push({
      id: "5",
      role: "combobox",
      name: "Token",
      ignored: false,
      childIds: [],
      target: 17,
      properties: {},
    });
    page.choose = async () => ({ kind: "no-match", options: ["None", KEY] });
    const read = await browser.inspect({});
    const ref = /combobox "Token" \[(g\d+:e\d+)\]/.exec(read.text)?.[1] as string;
    for (const ask of [
      { action: "select", ref, option: KEY_HIDDEN },
      { action: "set", ref, text: KEY_HIDDEN },
    ] as const) {
      const refusal = await browser.act(ask);
      expect(refusal.text).toContain(`Its options: "None", "${KEY_HIDDEN}".`);
      expect(refusal.text).not.toContain(KEY);
    }
  });

  it("reads a link's address bare where its host looks like a key, and hides a key in its path", async () => {
    const { browser, page } = await shownKey();
    page.nodeList.push(
      {
        id: "5",
        role: "link",
        name: "Docs",
        ignored: false,
        childIds: [],
        target: 51,
        properties: { url: "https://xai-docs.example.com/start?session=abc#top" },
      },
      {
        id: "6",
        role: "link",
        name: "This token",
        ignored: false,
        childIds: [],
        target: 52,
        properties: { url: `https://keys.example/tokens/${KEY}?tab=new` },
      },
    );
    const read = await browser.inspect({});
    expect(read.text).toContain(`link "Docs" [g2:e2] → https://${KEY_HIDDEN}.example.com/start`);
    expect(read.text).toContain(`link "This token" [g2:e3] → /tokens/${KEY_HIDDEN}`);
    expect(read.text).not.toContain("session=abc");
    expect(read.text).not.toContain(KEY);
  });

  it("lists a request to the page's address with the key hidden in the network list", async () => {
    const { browser, page } = await shownKey();
    page.opened.onNetwork({
      kind: "request",
      id: "reload",
      method: "GET",
      type: "Document",
      url: page.current,
    });
    page.opened.onNetwork({ kind: "response", id: "reload", status: 200 });
    const listed = await browser.inspect({ show: "network" });
    expect(listed.text).toContain(
      `- GET https://keys.example/tokens/${KEY_HIDDEN} (Document; status 200)`,
    );
    expect(listed.diagnostics).toMatchObject({
      rows: [{ url: `https://keys.example/tokens/${KEY_HIDDEN}` }],
    });
    expect(JSON.stringify(listed)).not.toContain(KEY);
  });

  it("reads a browser never handed back as it is", async () => {
    const { browser } = await shownKey(false);
    const read = await browser.inspect({});
    expect(read.text).toContain(`text "Your key: ${KEY}"`);
    expect(read.text).not.toContain(KEY_HIDDEN);
    expect(read.text).not.toContain(KEYS_HIDDEN_WORDS);
  });
});
