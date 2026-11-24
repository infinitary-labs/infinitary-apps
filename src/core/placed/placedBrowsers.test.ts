import { PROTOCOL_VERSION } from "@shared/ipc";
import { describe, expect, it, vi } from "vitest";
import { asAView } from "../askedFromAView";
import { failedSignInNote } from "../browser/savedSignInGrants";
import { DeviceOutOfReachError } from "../connection/connection";
import { PlacedBrowsers } from "./placedBrowsers";
import type { WorkDevices } from "./workDevices";

/**
 * A task's browser on another computer, from the captain's side
 * (docs/task-browser.md, "On another computer"): INF-4585's plan keeps each
 * signed-in site on the computer whose kept profile holds it, so this Mac
 * sends that computer the captain's rule, a grant, a failure mark, Settings'
 * reads and Removes, and nothing of a sign-in crosses.
 */
const site = "club.example";
const handle = { session: "work-browser", generation: 1 };

function setup(
  answer: (channel: string, args: unknown) => Promise<unknown>,
  options: { keeps?: boolean; computers?: string[]; changes?: string[] } = {},
) {
  const notes: string[] = [];
  const logs: string[] = [];
  const asked: [string, string, unknown][] = [];
  const browsers = new PlacedBrowsers({
    devices: {
      ask: async (device, channel, args) => {
        asked.push([device, channel, args]);
        return answer(channel, args);
      },
      onWorkDevice: () => () => {},
      version: () => ({
        contract: PROTOCOL_VERSION,
        takesWork: true,
        changes: options.changes ?? (options.keeps === false ? [] : ["kept-sign-ins"]),
      }),
    } as Pick<WorkDevices, "ask" | "onWorkDevice" | "version">,
    deviceOf: () => "work-computer",
    nameOf: (deviceId) => (deviceId === "work-computer" ? "Work computer" : "Windows PC"),
    computers: () => options.computers ?? ["work-computer"],
    note: (task, text) => notes.push(`${task}: ${text}`),
    onChange: () => {},
    onReturned: () => {},
    log: (line) => logs.push(line),
  });
  browsers.heardFact("work-computer", "task", {
    state: "open",
    site,
    url: `https://${site}/`,
    title: "Club",
    control: "captain",
    kept: true,
    ...handle,
  });
  return { browsers, notes, logs, asked };
}

describe("signed-in sites a computer that runs work keeps", () => {
  // The captain's answer on INF-6521's review: name the computer that keeps the sign-in.
  it("names that computer on its open browser's fact", () => {
    const { browsers } = setup(async () => ({ ok: true }));
    expect(browsers.fact("task")).toMatchObject({
      state: "open",
      kept: true,
      computer: "Work computer",
    });
  });

  it("sends the captain's rule with Return control from that computer's kept profile, and none to an older one", async () => {
    const { browsers, asked } = setup(async () => ({ ok: true }));
    expect(await browsers.returnControl("task", handle, { site, automatic: true })).toEqual({
      ok: true,
    });
    expect(asked).toEqual([
      [
        "work-computer",
        "inf:task-browser:return",
        [{ task: "task", handle, rule: { site, automatic: true } }],
      ],
    ]);
    const older = setup(async () => ({ ok: true }), { keeps: false });
    await older.browsers.returnControl("task", handle, { site, automatic: true });
    expect(older.asked).toEqual([
      ["work-computer", "inf:task-browser:return", [{ task: "task", handle }]],
    ]);
  });

  it("asks that computer to use its own sign-in on the captain's click, and refuses one not yet updated", async () => {
    const { browsers, asked } = setup(async () => ({ ok: true }));
    expect(await browsers.grantSavedSignIn("task", handle)).toEqual({ ok: true });
    expect(asked).toEqual([
      ["work-computer", "inf:task-browser:use-sign-in", [{ task: "task", handle }]],
    ]);
    const older = setup(async () => ({ ok: true }), { keeps: false });
    expect(await older.browsers.grantSavedSignIn("task", handle)).toEqual({
      ok: false,
      text: "Work computer keeps no sign-ins until Infinitary there is updated.",
    });
    expect(older.asked).toEqual([]);
  });

  it("tells that computer a crewmate's failure only for a site its browser was given", async () => {
    const { browsers, notes, asked } = setup(async () => ({ ok: true }));
    expect(browsers.markSavedSignInFailed("task", site)).toBe(false);
    browsers.heardFact("work-computer", "task", {
      state: "open",
      site,
      url: `https://${site}/`,
      title: "Club",
      kept: true,
      saved: [site],
      ...handle,
    });
    expect(browsers.markSavedSignInFailed("task", site)).toBe(true);
    await new Promise((settle) => setImmediate(settle));
    expect(asked).toEqual([
      ["work-computer", "inf:task-browser:sign-in-failed", [{ task: "task", site }]],
    ]);
    // The line is that computer's own note, heard once.
    expect(notes).toEqual([]);
    browsers.heardEvent("work-computer", "task", {
      kind: "note",
      text: failedSignInNote(site),
    });
    expect(notes).toEqual([`task: said your sign-in at ${site} did not sign its page in`]);
  });

  it("lists each computer's sites for Settings, says which could not be asked, and leaves out one not yet updated", async () => {
    const { browsers } = setup(
      async (channel) => {
        expect(channel).toBe("inf:task-browser:sign-ins");
        return { signIns: [{ site, savedAt: 1_000, id: "entry", automatic: true }] };
      },
      { computers: ["work-computer"] },
    );
    expect(await browsers.signInsThere()).toEqual([
      {
        deviceId: "work-computer",
        name: "Work computer",
        signIns: [{ site, savedAt: 1_000, id: "entry", automatic: true }],
      },
    ]);
    const away = setup(async () => {
      throw new DeviceOutOfReachError();
    });
    expect(await away.browsers.signInsThere()).toEqual([
      { deviceId: "work-computer", name: "Work computer", signIns: [], unreachable: true },
    ]);
    const older = setup(async () => ({ signIns: [] }), { keeps: false });
    expect(await older.browsers.signInsThere()).toEqual([]);
  });

  it("sends a rule and a Remove to the computer that keeps the site, and says when it is out of reach", async () => {
    const { browsers, asked } = setup(async () => ({ ok: true }));
    expect(await browsers.ruleThere("work-computer", site, "entry", true)).toEqual({ ok: true });
    expect(await browsers.removeThere("work-computer", site)).toEqual({ ok: true });
    expect(await browsers.removeAllThere("work-computer")).toEqual({ ok: true });
    expect(asked).toEqual([
      ["work-computer", "inf:task-browser:sign-in-rule", [{ site, id: "entry", automatic: true }]],
      ["work-computer", "inf:task-browser:sign-in-remove", [{ site }]],
      ["work-computer", "inf:task-browser:sign-in-remove-all", []],
    ]);
    const away = setup(async () => {
      throw new DeviceOutOfReachError();
    });
    expect(await away.browsers.removeThere("work-computer", site)).toEqual({
      ok: false,
      text: "Work computer is out of reach right now. Try again once it is back.",
    });
  });

  // INF-3129 review, the captain's ruling: a Remove stops every open task browser at once.
  it("gives the private sites list to each computer with an open browser, and only logs an older computer's refusal", async () => {
    const asked: unknown[] = [];
    const { browsers, logs } = setup(async (channel, args) => {
      asked.push([channel, args]);
      throw new Error("No such order");
    });
    browsers.privateSitesChanged([".corp.example"]);
    await new Promise((settle) => setImmediate(settle));
    expect(asked).toEqual([["inf:task-browser:private-sites", [{ sites: [".corp.example"] }]]]);
    expect(logs).toEqual([
      "could not give work-computer's browsers the private sites list: No such order",
    ]);
    browsers.heardFact("work-computer", "task", null);
    browsers.privateSitesChanged([]);
    await new Promise((settle) => setImmediate(settle));
    expect(asked).toHaveLength(1);
  });

  // INF-3211 review note: a Remove made while that computer was out of reach reaches it once heard from.
  it("gives a computer the private sites list again when it is back in reach with an open browser", async () => {
    const asked: unknown[] = [];
    let reach: ((contact: { deviceId: string; contact: string }) => void) | undefined;
    const browsers = new PlacedBrowsers({
      devices: {
        ask: async (_device, channel, args) => {
          asked.push([channel, args]);
          return channel === "inf:task-browser:facts"
            ? {
                facts: [
                  {
                    task: "task",
                    fact: {
                      state: "open",
                      site,
                      url: `https://${site}/`,
                      title: "Club",
                      ...handle,
                    },
                  },
                ],
              }
            : { ok: true };
        },
        onWorkDevice: (listener) => {
          reach = listener as typeof reach;
          return () => {};
        },
        version: () => undefined,
      } as Pick<WorkDevices, "ask" | "onWorkDevice" | "version">,
      deviceOf: () => "work-computer",
      nameOf: () => "Work computer",
      privateSites: { list: () => [".corp.example"] },
      note: () => {},
      onChange: () => {},
      onReturned: () => {},
      log: () => {},
    });
    reach?.({ deviceId: "work-computer", contact: "in-reach" });
    await vi.waitFor(() =>
      expect(asked).toContainEqual([
        "inf:task-browser:private-sites",
        [{ sites: [".corp.example"] }],
      ]),
    );
    expect(browsers.holds("task")).toBe(true);
  });
});

describe("a page's asks on that computer (docs/task-browser.md, \"A site's asks\")", () => {
  it("tells that computer whether the captain's window is there, which only Chrome there can use for a passkey", async () => {
    const { browsers, asked } = setup(async () => ({ ok: true }), {
      changes: ["kept-sign-ins", "browser-asks"],
    });
    // This Mac's own window is away from that computer; that computer's own window is there.
    await browsers.takeControl("task", handle);
    await asAView(() => browsers.takeControl("task", handle), { view: "work-computer" });
    await asAView(() => browsers.captainInput("task", { kind: "go", go: "reload" }), {
      view: "phone",
    });
    await asAView(() => browsers.answerAsk("task", handle, 3, "show"), {
      view: "work-computer",
    });
    expect(asked).toEqual([
      ["work-computer", "inf:task-browser:take", [{ task: "task", handle, here: false }]],
      ["work-computer", "inf:task-browser:take", [{ task: "task", handle, here: true }]],
      [
        "work-computer",
        "inf:task-browser:input",
        [{ task: "task", input: { kind: "go", go: "reload" }, here: false }],
      ],
      [
        "work-computer",
        "inf:task-browser:ask",
        [{ task: "task", handle, id: 3, answer: "show", here: true }],
      ],
    ]);
  });

  it("sends no answer to a computer not yet updated, which never asks", async () => {
    const { browsers, asked } = setup(async () => ({ ok: true }));
    expect(await browsers.answerAsk("task", handle, 1, "allow")).toEqual({
      ok: false,
      text: "The page no longer asks for that.",
    });
    expect(asked).toEqual([]);
  });
});

/** Intent: the accepted Point at plan - a page on another computer is read by that computer, where its browser runs. */
describe('Point at on a page that computer runs (docs/task-browser.md, "Pointing at a page")', () => {
  const read = {
    ok: true,
    width: 1280,
    height: 800,
    url: `https://${site}/`,
    title: "Club",
    places: [{ role: "button", name: "Join", x: 40, y: 252, width: 72, height: 32 }],
  };

  it("asks that computer what its page names on screen, and gives the answer as it came", async () => {
    const { browsers, asked } = setup(async () => read, {
      changes: ["kept-sign-ins", "card-note-places"],
    });
    expect(await browsers.places("task")).toEqual(read);
    expect(asked).toEqual([["work-computer", "inf:task-browser:places", [{ task: "task" }]]]);
  });

  it("asks nothing of a computer not yet updated, and says the page could not be read", async () => {
    const { browsers, asked } = setup(async () => read);
    expect(await browsers.places("task")).toEqual({ ok: false });
    expect(asked).toEqual([]);
  });

  it("says the page could not be read while that computer is out of reach", async () => {
    const { browsers } = setup(
      async () => {
        throw new DeviceOutOfReachError("work-computer");
      },
      { changes: ["kept-sign-ins", "card-note-places"] },
    );
    expect(await browsers.places("task")).toMatchObject({ ok: false });
  });
});
