import type { Core } from "@core/index";
import {
  type GoogleStandIn,
  STAND_IN_CLIENT_ID,
  STAND_IN_CLIENT_SECRET,
  startGoogleStandIn,
} from "./googleStandIn";

/**
 * INF-3454's phone part: the phone check's computer signs in to a stand-in
 * Google (docs/ios.md, "Google in Settings"). The phone asks for the
 * sign-in; its browser is the test, which approves on the stand-in's page
 * and reads the address Google sends it back to, as a person's browser
 * would end on it. The simulator shares this computer's loopback address,
 * where the sign-in itself listens, so the phone there pastes that address.
 */
export async function startPhoneGoogle(): Promise<GoogleStandIn> {
  const google = await startGoogleStandIn();
  // Read once the computer's integrations start; an unpackaged run names its stand-in Google this way.
  process.env.INFINITARY_GOOGLE_CLIENT_ID = STAND_IN_CLIENT_ID;
  process.env.INFINITARY_GOOGLE_CLIENT_SECRET = STAND_IN_CLIENT_SECRET;
  process.env.INFINITARY_GOOGLE_URL = google.base;
  return google;
}

/** The control requests the phone's Google journey makes of its computer. */
export function phoneGoogleControls(core: Core) {
  const pages: { url: string; id: string; port: number }[] = [];
  const stop = core.events.subscribe((channel, payload) => {
    if (channel === "inf:app:sign-in-page") pages.push(payload as (typeof pages)[number]);
  });
  return {
    /**
     * The person approves on the newest sign-in page: the address the
     * browser is sent back to, and one from another sign-in, which the
     * waiting sign-in refuses.
     */
    async approve(): Promise<{ address: string; other: string }> {
      const page = pages.at(-1);
      if (!page) throw new Error("No sign-in page was opened for the phone");
      const consent = await fetch(page.url, { redirect: "manual" });
      const address = consent.headers.get("location");
      if (!address) throw new Error("The stand-in Google sent the browser nowhere");
      const other = new URL(address);
      other.searchParams.set("state", "from-another-sign-in");
      return { address, other: other.toString() };
    },
    /** Who the computer is signed in to Google as, and how many sign-in pages it opened for its views. */
    async state(): Promise<{ account: string | null; pages: number }> {
      const view = await core.dispatch("inf:integrations:list", []);
      const google = view.integrations.find((integration) => integration.kind === "google");
      return { account: google?.account ?? null, pages: pages.length };
    },
    close: stop,
  };
}
