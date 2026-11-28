import { expect, test, vi } from "vitest";
import { startPhoneHome } from "./helpers/phoneHome";
import { scratchDir } from "./helpers/scratchDirs";

// INF-7136: the phone check's cards-merge part (PhoneJourney+CardsMerge.swift, verifyCardReadiness) waits for the
// card the test home holds to reach the phone's stage each time the home releases it. A host revision keeps an open
// card's hold (`CardService.put`), so the home lifts the hold as the app does; this reads that release over the
// published contract on every change, where the part itself runs only on a phone Mac.
// Budget: one local TLS home and client, as tests/phone-scene-projection.test.ts measures; the default five seconds
// suffices.
test("the stand-in Mac's held card reaches the phone's stage each time the home releases it", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  for (const name of ["INFINITARY_CONNECTION_LOOPBACK_PORT", "INFINITARY_DNS_SD"])
    vi.stubEnv(name, process.env[name]);
  const home = await startPhoneHome(scratchDir("infinitary-phone-readiness-"));
  const post = async (command: string) => {
    const response = await fetch(`${home.url}/${command}`, { method: "POST" });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body;
  };
  try {
    const { held, ready } = await post("held-card-fixture");
    await home.asPhone(async (ask) => {
      type WireCard = {
        id: string;
        title: string;
        body: string;
        awaiting?: string;
        sentBackAt?: number;
        minimized?: boolean;
      };
      const cards = async () => {
        const answer = await ask("inf:cards:list", []);
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
        return answer.value as WireCard[];
      };
      // The phone's stage, as `ReadOnlySession.stack` reads the list: a card waiting on its author stays off it unless
      // the captain's reply holds it, and a card put aside stays off it.
      const stage = async () =>
        (await cards()).filter(
          (card) =>
            (card.awaiting === undefined || card.sentBackAt !== undefined) && !card.minimized,
        );
      expect((await stage()).map((card) => card.title)).toEqual([ready]);
      const witness = (await cards()).find((card) => card.title === ready);
      expect(await ask("inf:cards:minimize", [witness?.id, true])).toMatchObject({ ok: true });
      expect(await stage()).toEqual([]);

      await post("release-held-card");
      const released = await stage();
      expect(released.map((card) => card.title)).toEqual([held]);
      expect(released[0]?.body).toContain("The harbour survey is ready for your choice.");
      expect(released[0]?.awaiting).toBeUndefined();

      await post("replied-under-card");
      const replied = await stage();
      expect(replied.map((card) => card.title)).toEqual([held]);
      expect(replied[0]?.body).toContain("The surveyor is answering your harbour question.");

      await post("release-held-card");
      const answered = await stage();
      expect(answered.map((card) => card.title)).toEqual([held]);
      expect(answered[0]?.body).toContain("The harbour survey is ready for your choice.");
      expect(answered[0]?.awaiting).toBeUndefined();
    });
  } finally {
    await home.close();
    vi.unstubAllEnvs();
  }
});
