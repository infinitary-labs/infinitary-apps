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

const DRIVE = "https://www.googleapis.com/auth/drive";

/** The file Google Cloud gives for the person's own Desktop app client, as the phone's person pastes it. */
export const PHONE_GOOGLE_CLIENT_FILE = JSON.stringify({
  installed: {
    client_id: OWN_CLIENT_ID,
    client_secret: OWN_CLIENT_SECRET,
    redirect_uris: ["http://localhost"],
  },
});

/** The control requests the phone's Google journey makes of its computer. */
export function phoneGoogleControls(core: Core, stand: GoogleStandIn) {
  const pages: { url: string; id: string; port: number }[] = [];
  const stop = core.events.subscribe((channel, payload) => {
    if (channel === "inf:app:sign-in-page") pages.push(payload as (typeof pages)[number]);
  });
  /**
   * The person approves on the newest sign-in page: the address the
   * browser is sent back to, and one from another sign-in, which the
   * waiting sign-in refuses.
   */
  const approve = async (): Promise<{ address: string; other: string }> => {
    const page = pages.at(-1);
    if (!page) throw new Error("No sign-in page was opened for the phone");
    const consent = await fetch(page.url, { redirect: "manual" });
    const address = consent.headers.get("location");
    if (!address) throw new Error("The stand-in Google sent the browser nowhere");
    const other = new URL(address);
    other.searchParams.set("state", "from-another-sign-in");
    return { address, other: other.toString() };
  };
  /**
   * Who the computer is signed in to Google as, how many sign-in pages it
   * opened for its views, which client the newest asked Google for,
   * whether the computer keeps the person's own client, and that client's
   * file as Google Cloud gives it, for the phone's person to paste.
   */
  const state = async (): Promise<{
    account: string | null;
    pages: number;
    client: string | null;
    kept: boolean;
    own: { file: string; id: string };
  }> => {
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
  };
  /**
   * Google's MCP servers refuse the sign-in's client as not marked for an
   * AI-powered agent (`true`), or take it again (`false`), and the computer
   * asks Google again as Check now does: what its Google row then says
   * Google refused.
   */
  const markRefused = async (refused: boolean): Promise<{ refused: string | null }> => {
    const listed = await core.dispatch("inf:integrations:list", []);
    const row = listed.integrations.find((integration) => integration.kind === "google");
    if (!row) throw new Error("The computer is not signed in to Google");
    stand.knobs.agentRefused = refused;
    const view = await core.dispatch("inf:integrations:check", [row.id]);
    const google = view.integrations.find((integration) => integration.id === row.id);
    return { refused: google?.client?.mcp?.refused ?? null };
  };
  /**
   * What the person ticks on Google's page for the next sign-in: every box
   * but Drive (`false`), or every box (`true`), as INF-7009's row line
   * "Drive, Docs and Sheets not added" needs a sign-in that left Drive out.
   * The row's date a client in Testing stops outranks that line, so the
   * sign-in without Drive is made as a client in Production, which Google
   * names no end for; every box goes back to the stand-in's Testing client.
   */
  const everyBox = [...stand.knobs.consent.grant];
  const testingLasts = stand.knobs.lasts;
  const tickDrive = (drive: boolean): { grant: string[] } => {
    stand.knobs.consent.grant = drive ? [...everyBox] : everyBox.filter((scope) => scope !== DRIVE);
    stand.knobs.lasts = drive ? testingLasts : undefined;
    return { grant: stand.knobs.consent.grant };
  };
  return {
    /**
     * Answers one of the journey's requests, named by its method and path as
     * the phone home names it; undefined for a request that is not Google's.
     */
    answer(request: string): Promise<unknown> {
      switch (request) {
        case "POST google-approve":
          return approve();
        case "GET google-state":
          return state();
        case "POST google-agent-refused":
          return markRefused(true);
        case "POST google-agent-marked":
          return markRefused(false);
        case "POST google-without-drive":
          return Promise.resolve(tickDrive(false));
        case "POST google-every-box":
          return Promise.resolve(tickDrive(true));
        default:
          return Promise.resolve(undefined);
      }
    },
    close: stop,
  };
}
