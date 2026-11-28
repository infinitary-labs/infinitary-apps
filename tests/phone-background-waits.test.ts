import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { scratchDir } from "./helpers/scratchDirs";

// The native phone check's record part selects one of three background-work wait states through the
// test home's `background-wait-fixture`; each must reach the board read the phone's record is built from
// as the wait the Mac's own projection gives: a known start, a check-back that owns the wait, no known start.
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
        startedAt: number;
        wait?: { label: string; since?: number; next?: { kind: string } };
      };
    };
    const started = await seed("started");
    expect(started.wait).toMatchObject({ label: "Background work", since: started.startedAt });
    expect(started.wait?.next).toBeUndefined();

    const owned = await seed("check-back");
    expect(owned.wait).toMatchObject({ label: "Website build", next: { kind: "check-back" } });
    expect(owned.wait?.since).not.toBe(owned.startedAt - 60 * 60_000);

    const unknown = await seed("unknown");
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
