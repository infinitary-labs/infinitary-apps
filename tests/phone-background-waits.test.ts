import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { scratchDir } from "./helpers/scratchDirs";

// The test home's `background-wait-fixture` seeds the three background-work wait states the phone's
// record words, for a native phone check to select by name; no checked-in native check calls it yet.
// Each state must come out of the real wait projection and board read as the wait the Mac gives:
// a known start, a check-back that owns the wait, no known start.
test("the test home seeds the three background-work wait states the phone's record words", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  for (const name of ["INFINITARY_CONNECTION_LOOPBACK_PORT", "INFINITARY_DNS_SD"])
    vi.stubEnv(name, process.env[name]);
  const home = await startPhoneHome(scratchDir("infinitary-phone-background-waits-"));
  try {
    const seed = async (state: string) => {
      const response = await fetch(`${home.url}/background-wait-fixture`, {
        method: "POST",
        body: JSON.stringify({ state }),
      });
      expect(response.ok, await response.clone().text()).toBe(true);
      return (await response.json()) as {
        jobSince?: number;
        wait?: { label: string; since?: number; next?: { kind: string; at: number } };
      };
    };
    const started = await seed("started");
    expect(started.jobSince).toBeDefined();
    expect(started.wait).toMatchObject({ label: "Background work", since: started.jobSince });
    expect(started.wait?.next).toBeUndefined();

    const owned = await seed("check-back");
    const own = owned.wait;
    expect(own).toMatchObject({ label: "Website build", next: { kind: "check-back" } });
    expect(typeof owned.jobSince).toBe("number");
    expect(typeof own?.since).toBe("number");
    expect(owned.jobSince as number).toBeLessThan(own?.since as number);
    expect((own?.next?.at ?? 0) - (own?.since ?? 0)).toBe(30 * 60_000);

    const unknown = await seed("unknown");
    expect(unknown.jobSince).toBeUndefined();
    expect(unknown.wait).toMatchObject({ label: "Background work" });
    expect(unknown.wait).not.toHaveProperty("since");
    expect(unknown.wait).not.toHaveProperty("next");

    const refused = await fetch(`${home.url}/background-wait-fixture`, {
      method: "POST",
      body: JSON.stringify({ state: "later" }),
    });
    expect(refused.status).toBe(500);
  } finally {
    await home.close();
    vi.unstubAllEnvs();
  }
});
