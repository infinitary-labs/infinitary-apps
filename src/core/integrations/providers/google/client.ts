import { settingFrom } from "@shared/envSettings";

/**
 * Who Infinitary is to Google, and where Google answers (docs/integrations.md,
 * "Google"). Each person signs in as their own Google client, made in
 * Google's Personal mode (INF-5549's plan). Infinitary ships no client of its
 * own: only a development run names one (`googleSetup`), for tests.
 *
 * A desktop client is public: Google gives it an id, and a secret that an
 * installed app carries and Google does not treat as confidential. PKCE is
 * what ties a sign-in to the app that began it.
 */
export type GoogleClient = { id: string; secret?: string };

/** Gmail: read, search, label, draft and send - everything but deleting for good. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/**
 * Every permission the one Google row asks, up front (the captain's q8:
 * "One Google row that signs in once for both, asking every permission up
 * front"): Gmail's, and Calendar's for its events, its calendar list and
 * availability, since an installed app cannot add a permission later.
 * The calendar list and availability take the narrowest scope Google
 * accepts for `calendarList.list` and `freeBusy.query` (INF-953), in place
 * of `calendar.readonly`; a sign-in that granted `calendar.readonly` keeps
 * working, since Google accepts it for both calls.
 */
export const GOOGLE_SCOPES: readonly string[] = [
  GMAIL_SCOPE,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];

export type GoogleEndpoints = {
  /** The consent page the person's browser opens. */
  auth: string;
  token: string;
  revoke: string;
  /** Gmail's API, before `/gmail/v1/`. */
  gmail: string;
  calendar: string;
};

const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  gmail: "https://gmail.googleapis.com",
  calendar: "https://www.googleapis.com",
};

/**
 * The run's client and the addresses it reaches.
 * An unpackaged run may name a stand-in Google
 * (`INFINITARY_GOOGLE_URL`, every address under it) and a client
 * (`INFINITARY_GOOGLE_CLIENT_ID`, `INFINITARY_GOOGLE_CLIENT_SECRET`), which
 * then also takes new sign-ins (`signsIn`); a packaged build reaches only
 * Google and names no client, so a sign-in made with Infinitary's retired
 * client cannot renew.
 */
export function googleSetup(options: { packaged: boolean; env?: NodeJS.ProcessEnv }): {
  client?: GoogleClient;
  signsIn: boolean;
  endpoints: GoogleEndpoints;
} {
  const env = options.env ?? process.env;
  const named = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_ID")?.trim();
  const secret = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_SECRET")?.trim();
  const client = named ? { id: named, ...(secret ? { secret } : {}) } : undefined;
  const signsIn = named !== undefined && named !== "";
  const base = options.packaged ? undefined : settingFrom(env, "GOOGLE_URL")?.trim();
  if (!base) return { ...(client ? { client } : {}), signsIn, endpoints: GOOGLE_ENDPOINTS };
  const root = base.replace(/\/+$/, "");
  return {
    ...(client ? { client } : {}),
    signsIn,
    endpoints: {
      auth: `${root}/o/oauth2/v2/auth`,
      token: `${root}/token`,
      revoke: `${root}/revoke`,
      gmail: root,
      calendar: root,
    },
  };
}
