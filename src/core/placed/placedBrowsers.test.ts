import { describe, expect, it } from "vitest";
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
  const browsers = new PlacedBrowsers({
    devices: {
      ask: async (_device, channel, args) => answer(channel, args),
      onWorkDevice: () => () => {},
    } as Pick<WorkDevices, "ask" | "onWorkDevice">,
    deviceOf: () => "work-computer",
    nameOf: () => "Work computer",
    signIns: store,
    note: () => {},
    onChange: () => {},
    onReturned: () => {},
  });
  browsers.heardFact("work-computer", "task", {
    state: "open",
    site,
    url: `https://${site}/`,
    title: "Club",
    control: "captain",
    ...handle,
  });
  return { store, browsers };
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
});
