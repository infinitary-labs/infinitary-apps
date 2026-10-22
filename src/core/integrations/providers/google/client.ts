import { settingFrom } from "@shared/envSettings";

/**
 * Who Infinitary is to Google, and where Google answers (docs/integrations.md,
 * "Google"). The captain's INF-887 rollout enables the registered client in
 * both release channels for private testing; Google controls account access.
 *
 * A desktop client is public: Google gives it an id, and a secret that an
 * installed app carries and Google does not treat as confidential, so both
 * live in the code the way the GitHub client id does
 * (`GITHUB_OAUTH_CLIENT_ID`). PKCE is what ties a sign-in to the app that
 * began it.
 */
export type GoogleClient = { id: string; secret?: string };

/** Infinitary's registered public Desktop app client, shared by development and released builds. */
export const GOOGLE_OAUTH_CLIENT: GoogleClient = {
  id: "634239586896-ucb4ehoc6m5o6ph8cer0n599u38m8mm1.apps.googleusercontent.com",
  secret: "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",
};

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
 * The client and the addresses a run signs in with.
 * An unpackaged run may name a stand-in Google
 * (`INFINITARY_GOOGLE_URL`, every address under it) and a client
 * (`INFINITARY_GOOGLE_CLIENT_ID`, `INFINITARY_GOOGLE_CLIENT_SECRET`); a
 * packaged build reaches only Google, and only as Infinitary's own client.
 */
export function googleSetup(options: { packaged: boolean; env?: NodeJS.ProcessEnv }): {
  client: GoogleClient;
  endpoints: GoogleEndpoints;
} {
  const env = options.env ?? process.env;
  const named = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_ID")?.trim();
  const secret = options.packaged ? undefined : settingFrom(env, "GOOGLE_CLIENT_SECRET")?.trim();
  const client = named ? { id: named, ...(secret ? { secret } : {}) } : GOOGLE_OAUTH_CLIENT;
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
