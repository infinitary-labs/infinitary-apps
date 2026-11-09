import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { WebSignIns } from "../browser/webSignIns";
import { PlacedBrowsers } from "./placedBrowsers";
import type { WorkDevices } from "./workDevices";

// Approved INF-920: the home owns persistent sign-ins even when a browser runs elsewhere.
const site = "club.example";
const held = {
  cookies: [],
  storage: [{ origin: `https://${site}`, items: [["member", "Sam"] as [string, string]] }],
};
const handle = { session: "work-browser", generation: 1 };
function setup(answer: (channel: string, args: unknown) => Promise<unknown>) {
  const store = new WebSignIns(scratchDir("infinitary-home-sign-ins-"));
  const notes: string[] = [];
  const logs: string[] = [];
  const browsers = new PlacedBrowsers({
    devices: {
      ask: async (_device, channel, args) => answer(channel, args),
      onWorkDevice: () => () => {},
    } as Pick<WorkDevices, "ask" | "onWorkDevice">,
    deviceOf: () => "work-computer",
    nameOf: () => "Work computer",
    signIns: store,
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
    ...handle,
  });
  return { store, browsers, notes, logs };
}

describe("home-owned saved-site handback across computers", () => {
  it("returns an opted-in site only after separate permission and revokes future access without removing the save", () => {
    const { store, browsers } = setup(async () => ({ ok: true }));
    const record = store.save(site, held);
    expect(browsers.automaticSignIn("task", site)).toBeUndefined();
    store.allowAutomatic(site, record.id, true);
    expect(browsers.automaticSignIn("task", site)).toMatchObject({
      id: record.id,
      automatic: true,
      storage: held.storage,
    });
    expect(browsers.automaticSignIn("task", "elsewhere.example")).toBeUndefined();
    store.allowAutomatic(site, record.id, false);
    expect(browsers.automaticSignIn("task", site)).toBeUndefined();
    expect(store.get(site)?.id).toBe(record.id);
  });

  it("binds a remote refresh to the shown site and save identity, preserving permission and refusing late removed or replaced records", async () => {
    let stale: (() => void) | undefined;
    const { store, browsers } = setup(async (channel, args) => {
      expect(channel).toBe("inf:task-browser:return");
      expect(args).toEqual([
        { task: "task", handle, remember: { id: record.id, site, refresh: true } },
      ]);
      stale?.();
      return { ok: true, remembered: { site, held } };
    });
    const record = store.save(site, held);
    store.allowAutomatic(site, record.id, true);
    expect(await browsers.returnControl("task", handle, { site, savedId: record.id })).toEqual({
      ok: true,
    });
    expect(store.get(site)).toMatchObject({ id: record.id, automatic: true });
    stale = () => {
      store.remove(site);
    };
    expect(
      await browsers.returnControl("task", handle, { site, savedId: record.id }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("removed or replaced") });
    expect(store.get(site)).toBeUndefined();
    const replacement = store.save(site, held);
    stale = undefined;
    expect(
      await browsers.returnControl("task", handle, { site, savedId: record.id }),
    ).toMatchObject({ ok: true, warning: expect.stringContaining("removed or replaced") });
    expect(store.get(site)).toEqual(replacement);
  });

  it("does not save a redirected site or falsely claim success when the work computer fails", async () => {
    const { store, browsers } = setup(async () => ({
      ok: true,
      remembered: { site: "elsewhere.example", held },
    }));
    expect(await browsers.returnControl("task", handle, { site, remember: true })).toMatchObject({
      ok: true,
      warning: expect.stringContaining("no sign-in was saved"),
    });
    expect(store.list()).toEqual([]);
    const unavailable = setup(async () => {
      throw new Error("Work computer cannot be reached");
    });
    expect(
      await unavailable.browsers.returnControl("task", handle, { site, remember: true }),
    ).toEqual({ ok: false, text: "Work computer cannot be reached" });
    expect(unavailable.store.list()).toEqual([]);
  });

  it("carries session storage both ways, and leaves it as saved when a stop or an older computer sends none (INF-1849)", async () => {
    const session = [
      { origin: `https://${site}`, items: [["repository", "token-1"]] as [string, string][] },
    ];
    const asked: unknown[] = [];
    const { store, browsers } = setup(async (channel, args) => {
      asked.push([channel, args]);
      return channel === "inf:task-browser:return"
        ? { ok: true, remembered: { site, held: { ...held, session } } }
        : { ok: true };
    });
    expect(await browsers.returnControl("task", handle, { site, remember: true })).toEqual({
      ok: true,
    });
    const record = store.get(site);
    expect(record?.session).toEqual(session);
    if (!record) throw new Error("The hand-back saved nothing");

    await browsers.grantSavedSignIn("task", handle);
    expect(asked.at(-1)).toMatchObject([
      "inf:task-browser:grant",
      [{ signIn: { id: record.id, session } }],
    ]);

    // A browser's stop there copies back cookies and local storage alone.
    browsers.heardEvent("work-computer", "task", {
      kind: "sign-in",
      site,
      id: record.id,
      held: { cookies: [], storage: held.storage },
    });
    expect(store.get(site)?.session).toEqual(session);
  });

  // INF-1849 piece 2: a crewmate on another computer marks the save the home lent its browser.
  it("marks the save this Mac lent a browser there when its crewmate says it failed, and nothing it did not lend", async () => {
    const { store, browsers, notes } = setup(async () => ({ ok: true }));
    const record = store.save(site, held);
    const usingSave = (saved: boolean) =>
      browsers.heardFact("work-computer", "task", {
        state: "open",
        site,
        url: `https://${site}/`,
        title: "Club",
        ...(saved ? { saved: [site] } : {}),
        ...handle,
      });
    // Nothing lent yet: nothing to mark.
    usingSave(true);
    expect(browsers.markSavedSignInFailed("task", site)).toBe(false);
    expect(store.get(site)?.failedAt).toBeUndefined();
    expect(await browsers.grantSavedSignIn("task", handle)).toEqual({ ok: true });
    // A browser there that no longer uses the save marks nothing.
    usingSave(false);
    expect(browsers.markSavedSignInFailed("task", site)).toBe(false);
    usingSave(true);
    expect(browsers.markSavedSignInFailed("task", site)).toBe(true);
    expect(store.get(site)).toMatchObject({ id: record.id, failedAt: expect.any(Number) });
    expect(notes).toEqual([`task: said your saved sign-in at ${site} did not sign its page in`]);
    expect(browsers.savedSignInFor("task", site)).toBeUndefined();
    // A save replaced since is never marked.
    store.save(site, held);
    expect(browsers.markSavedSignInFailed("task", site)).toBe(false);
    expect(store.get(site)?.failedAt).toBeUndefined();
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
      } as Pick<WorkDevices, "ask" | "onWorkDevice">,
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
