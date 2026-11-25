import type { Core } from "@core/index";
import {
  type GoogleStandIn,
  OWN_CLIENT_ID,
  OWN_CLIENT_SECRET,
  startGoogleStandIn,
} from "./googleStandIn";

/**
 * INF-3454's phone part: the phone check's computer signs in to a stand-in
 * Google (docs/ios.md, "Google in Settings"). The phone asks for the
 * sign-in; its browser is the test, which approves on the stand-in's page
 * and reads the address Google sends it back to, as a person's browser
 * would end on it. The simulator shares this computer's loopback address,
 * where the sign-in itself listens, so the phone there pastes that address.
 * INF-6342: the computer names no client of its own, as a released build,
 * so the phone sets up the person's own client from its file first.
 */
export async function startPhoneGoogle(): Promise<GoogleStandIn> {
  const google = await startGoogleStandIn();
  // Read once the computer's integrations start; an unpackaged run names its stand-in Google this way.
  delete process.env.INFINITARY_GOOGLE_CLIENT_ID;
  delete process.env.INFINITARY_GOOGLE_CLIENT_SECRET;
  process.env.INFINITARY_GOOGLE_URL = google.base;
  return google;
}

/** The file Google Cloud gives for the person's own Desktop app client, as the phone's person pastes it. */
export const PHONE_GOOGLE_CLIENT_FILE = JSON.stringify({
  installed: {
    client_id: OWN_CLIENT_ID,
    client_secret: OWN_CLIENT_SECRET,
    redirect_uris: ["http://localhost"],
  },
});

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
    /**
     * Who the computer is signed in to Google as, how many sign-in pages it
     * opened for its views, which client the newest asked Google for,
     * whether the computer keeps the person's own client, and that client's
     * file as Google Cloud gives it, for the phone's person to paste.
     */
    async state(): Promise<{
      account: string | null;
      pages: number;
      client: string | null;
      kept: boolean;
      own: { file: string; id: string };
    }> {
      const view = await core.dispatch("inf:integrations:list", []);
      const google = view.integrations.find((integration) => integration.kind === "google");
      const entry = view.addable.find((addable) => addable.kind === "google");
      const page = pages.at(-1);
      return {
        account: google?.account ?? null,
        pages: pages.length,
        client: page ? new URL(page.url).searchParams.get("client_id") : null,
        kept: (google?.client ?? entry?.client)?.kept === true,
        own: { file: PHONE_GOOGLE_CLIENT_FILE, id: OWN_CLIENT_ID },
      };
    },
    close: stop,
  };
}
