import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { scratchDir } from "./helpers/scratchDirs";

// The phone check's join-activity part (testActivityAndCatchUp) empties the stage, which reads the stand-in
// Mac's "Your phone is reading your Mac" note with its Got it, then asks for that note back through
// stream-reset. INF-2718 keeps a note the captain closed from coming back under its id, so the stand-in
// raised it again under the same id and answered 500, and the part failed on main.
// Budget: one local TLS home and client, as tests/phone-scene-projection.test.ts measures; the default five
// seconds suffices.
test("the stand-in Mac shows its reading note again after the captain read it, as a new note", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  for (const name of ["INFINITARY_CONNECTION_LOOPBACK_PORT", "INFINITARY_DNS_SD"])
    vi.stubEnv(name, process.env[name]);
  const home = await startPhoneHome(scratchDir("infinitary-phone-reading-"));
  try {
    const state = async () => {
      const response = await fetch(`${home.url}/state`);
      return (await response.json()) as {
        cardTitle: string;
        cards: { id: string; title: string }[];
      };
    };
    const { cardTitle, cards: before } = await state();
    const first = before.find((card) => card.title === cardTitle);
    expect(first, JSON.stringify(before)).toBeDefined();
    const emptied = await fetch(`${home.url}/empty-cards`, { method: "POST" });
    expect(emptied.ok, await emptied.text()).toBe(true);
    expect((await state()).cards).toEqual([]);

    const reset = await fetch(`${home.url}/stream-reset`, { method: "POST" });
    expect(reset.ok, await reset.text()).toBe(true);
    const shown = (await state()).cards.filter((card) => card.title === cardTitle);
    expect(shown).toHaveLength(1);
    // Something new goes on a new card: the note the captain read stays closed.
    expect(shown[0]?.id).not.toBe(first?.id);
    // The phone reads it over the published contract, as the part's next step waits for.
    const phone = await home.checkPublishedClient();
    expect(phone.cards.value).toContainEqual(
      expect.objectContaining({ id: shown[0]?.id, title: cardTitle }),
    );
  } finally {
    await home.close();
    vi.unstubAllEnvs();
  }
});
