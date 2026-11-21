import { TASK_BROWSER_PAGE } from "@shared/taskBrowser";
import { describe, expect, it } from "vitest";
import { type FakePage, formNodes, harness } from "../../../tests/helpers/taskBrowserStandIn";
import { KEY_HIDDEN } from "../keyFormats";
import type { BrowserNode } from "./outline";

/**
 * What the captain's Point at reads of a task's page (docs/task-browser.md,
 * "Pointing at a page"), against the stand-in host
 * (tests/helpers/taskBrowserStandIn.ts): the outline's names with their boxes,
 * and the page's address and title as its crewmate's own reads give them.
 */

/** The sign-up form as the host reads it: each control marked with the box its window shows it in. */
function shownForm(page: FakePage): BrowserNode[] {
  return formNodes().map((node) => {
    const box = node.target === undefined ? undefined : page.boxes.get(node.target);
    return box ? { ...node, onScreen: true, box } : node;
  });
}

async function opened(url: string) {
  const h = harness();
  const browser = h.browsers.forTask("t1");
  await browser.navigate({ url });
  const page = h.pages[0] as FakePage;
  page.nodeList = shownForm(page);
  return { ...h, browser, page, handle: { session: h.browsers.session, generation: 1 } };
}

describe("what Point at reads of a task's page", () => {
  it("names what the page shows with its boxes, at the page's size, with its address and title", async () => {
    const { browsers } = await opened("http://localhost:5173/sign-up?step=2#seat");
    expect(await browsers.places("t1")).toEqual({
      ok: true,
      ...TASK_BROWSER_PAGE,
      // No one signed in here: the address reads whole, as the crewmate's own reads give it.
      url: "http://localhost:5173/sign-up?step=2#seat",
      title: "Sign up",
      places: [
        { role: "textbox", name: "Name", x: 100, y: 200, width: 200, height: 20 },
        { role: "combobox", name: "Seat", x: 100, y: 240, width: 120, height: 20 },
        { role: "button", name: "Send", x: 10, y: 300, width: 60, height: 30 },
      ],
    });
  });

  it("reads nothing a page was typed into, and records nothing", async () => {
    const { browsers, page, notes } = await opened("http://localhost:5173/sign-up");
    const before = [...notes];
    const read = await browsers.places("t1");
    // The seat the page holds is a value: only the control's name is read.
    expect(JSON.stringify(read)).not.toContain("Aisle");
    expect(notes).toEqual(before);
    expect(page.effects).not.toContain("capture");
  });

  it("gives the address bare and hides a key once the captain signed in, as the crewmate's reads do", async () => {
    const { browsers, page, handle } = await opened("https://aurora.example/sign-in");
    // An invented key in GitHub's personal token format, built here so no file holds one whole.
    const key = ["github", "pat", "11FIXTURE0INVENTED0NOT0A0KEY0000000"].join("_");
    expect(await browsers.takeControl("t1", handle)).toEqual({ ok: true });
    page.current = "https://aurora.example/bookings?session=s3cret#top";
    page.pageTitle = `Token ${key}`;
    page.nodeList = shownForm(page).map((node) =>
      node.role === "button" ? { ...node, name: `Copy ${key}` } : node,
    );
    expect(await browsers.returnControl("t1", handle)).toEqual({ ok: true });
    const read = await browsers.places("t1");
    expect(read).toMatchObject({
      ok: true,
      url: "https://aurora.example/bookings",
      title: `Token ${KEY_HIDDEN}`,
    });
    expect(read.ok && read.places.at(-1)?.name).toBe(`Copy ${KEY_HIDDEN}`);
    expect(JSON.stringify(read)).not.toContain(key);
    expect(JSON.stringify(read)).not.toContain("s3cret");
  });

  it("answers that it could not be read for a task with no browser, or a page that is gone", async () => {
    const { browsers, page } = await opened("http://localhost:5173/sign-up");
    expect(await browsers.places("t2")).toEqual({ ok: false });
    page.nodes = async () => {
      throw new Error("the page's connection closed");
    };
    expect(await browsers.places("t1")).toEqual({ ok: false });
  });
});
