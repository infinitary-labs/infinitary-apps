import { describe, expect, it } from "vitest";
import { recordStarPageOpened } from "../releaseNotes/starAsk";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { StarRead } from "./starRead";

/**
 * The star ask's read (docs/release-notes.md "The star ask"): GitHub's
 * answer through the person's github.com sign-in, at most once a day, kept
 * for the next note.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 23, 18);

function setup(answer: () => Promise<{ status: number }>) {
  const settings = new SettingsStore(openInMemoryDatabase());
  const asked: string[] = [];
  let clock = NOW;
  let signedIn = true;
  const read = new StarRead({
    store: settings,
    signedIn: () => signedIn,
    get: (path) => {
      asked.push(path);
      return answer();
    },
    now: () => clock,
  });
  return {
    settings,
    asked,
    read: () => read.read(),
    later: (ms: number) => {
      clock += ms;
    },
    signOut: () => {
      signedIn = false;
    },
    star: () => settings.getReleaseTracking().starAsk?.star,
  };
}

describe("reading the star", () => {
  it("asks GitHub for the person's star on this project, and keeps 204 as starred", async () => {
    const f = setup(async () => ({ status: 204 }));
    expect(await f.read()).toBe("starred");
    expect(f.asked).toEqual(["/user/starred/infinitary-labs/infinitary-apps"]);
    expect(f.star()).toEqual({ starred: true, readAt: NOW });
    // A star closes the ask: nothing is asked again, even days later.
    f.later(5 * DAY);
    expect(await f.read()).toBe("skipped");
    expect(f.asked).toHaveLength(1);
  });

  it("keeps 404 as not starred, and asks again only after a day", async () => {
    const f = setup(async () => ({ status: 404 }));
    expect(await f.read()).toBe("not-starred");
    expect(f.star()).toEqual({ starred: false, readAt: NOW });
    f.later(DAY - 1);
    expect(await f.read()).toBe("skipped");
    f.later(1);
    expect(await f.read()).toBe("not-starred");
    expect(f.asked).toHaveLength(2);
    expect(f.star()).toEqual({ starred: false, readAt: NOW + DAY });
  });

  it("keeps the last answer when GitHub answers otherwise or cannot be reached", async () => {
    let answer: () => Promise<{ status: number }> = async () => ({ status: 404 });
    const f = setup(() => answer());
    await f.read();
    f.later(DAY);
    answer = async () => ({ status: 401 });
    expect(await f.read()).toBe("kept");
    answer = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    };
    expect(await f.read()).toBe("kept");
    expect(f.star()).toEqual({ starred: false, readAt: NOW });
  });

  it("asks nothing with no sign-in, or once the page was opened", async () => {
    const f = setup(async () => ({ status: 204 }));
    f.signOut();
    expect(await f.read()).toBe("skipped");
    const opened = setup(async () => ({ status: 204 }));
    recordStarPageOpened(opened.settings, NOW);
    expect(await opened.read()).toBe("skipped");
    expect([...f.asked, ...opened.asked]).toEqual([]);
  });
});
