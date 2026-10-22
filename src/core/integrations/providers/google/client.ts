import { settingFrom } from "@shared/envSettings";

/**
 * Who Infinitary is to Google, and where Google answers (docs/integrations.md,
 * "Google"). The captain's q4 on INF-775: "Infinitary's own client from the
 * start, so the Gmail piece waits for verification and the assessment".
 *
 * A desktop client is public: Google gives it an id, and a secret that an
 * installed app carries and Google does not treat as confidential, so both
 * live in the code the way the GitHub client id does
 * (`GITHUB_OAUTH_CLIENT_ID`). PKCE is what ties a sign-in to the app that
 * began it.
 */
export type GoogleClient = { id: string; secret?: string };

/**
 * Infinitary's own Google client: null until Infinitary registers it with
 * Google and passes Google's verification and the yearly security
 * assessment Gmail's permissions need, so a packaged build offers no
 * Google sign-in until then.
 */
export const GOOGLE_OAUTH_CLIENT: GoogleClient | null = null;

/** Gmail: read, search, label, draft and send - everything but deleting for good. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/**
 * Every permission the one Google row asks, up front (the captain's q8:
 * "One Google row that signs in once for both, asking every permission up
 * front"): Gmail's, and Calendar's for its events and its calendars, since
 * an installed app cannot add a permission later.
 */
export const GOOGLE_SCOPES: readonly string[] = [
  GMAIL_SCOPE,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
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
 * The client and the addresses a run signs in with, or undefined when it
 * has no client. An unpackaged run may name a stand-in Google
 * (`INFINITARY_GOOGLE_URL`, every address under it) and a client
 * (`INFINITARY_GOOGLE_CLIENT_ID`, `INFINITARY_GOOGLE_CLIENT_SECRET`); a
 * packaged build reaches only Google, and only as Infinitary's own client.
 */
export function googleSetup(options: {
  packaged: boolean;
  env?: NodeJS.ProcessEnv;
}): { client: GoogleClient; endpoints: GoogleEndpoints } | undefined {
  const env = options.env ?? process.env;
  const named = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_ID")?.trim();
  const secret = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_SECRET")?.trim();
  const client = named ? { id: named, ...(secret ? { secret } : {}) } : GOOGLE_OAUTH_CLIENT;
  if (!client) return undefined;
  const base = options.packaged ? undefined : settingFrom(env, "GOOGLE_URL")?.trim();
  if (!base) return { client, endpoints: GOOGLE_ENDPOINTS };
  const root = base.replace(/\/+$/, "");
  return {
    client,
    endpoints: {
      auth: `${root}/o/oauth2/v2/auth`,
      token: `${root}/token`,
      revoke: `${root}/revoke`,
      gmail: root,
      calendar: root,
    },
  };
}
