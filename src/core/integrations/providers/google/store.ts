import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgeSignInStateSchema } from "@shared/forges";
import { z } from "zod";

/**
 * The Google sign-in's facts (docs/integrations.md, "Google"): one file,
 * `userData/integrations/google.json` (0600 in the integrations' 0700
 * folder) - who it is signed in as, what Google granted, when the access
 * runs out and its health, and which Secrets entry keeps its lasting key.
 * No key is here: the lasting key lives in Secrets (`IntegrationKeys`), and
 * the access key it renews lives only in the app's memory. The person's own
 * Google client, when they set one up, is a second file beside it,
 * `google-client.json`, so a build that knows no own client never reads it.
 * The Google binding is the one writer of both.
 */

const GOOGLE_FILE = "google.json";
const CLIENT_FILE = "google-client.json";

const recordSchema = z
  .object({
    /** The Gmail address Google answered for the sign-in. */
    account: z.string().min(1).max(320),
    scopes: z.array(z.string().min(1)),
    /** When the access runs out, on the app's clock; it renews before then. */
    expiresAt: z.number(),
    health: forgeSignInStateSchema,
    signedInAt: z.number(),
    /**
     * The Secrets reference of the lasting key. A sign-in an earlier version
     * kept in its own file has none until the one move writes it, first,
     * before the key goes in (`movedKeys.ts`).
     */
    key: z.string().min(1).max(64).optional(),
    /**
     * The id of the person's own client this sign-in was made with; absent,
     * it was made with Infinitary's retired client, or a development run's own
     * (`googleSetup`); a packaged run names none, so nothing renews it.
     */
    client: z.string().min(1).max(256).optional(),
    /**
     * When Google said the lasting key itself runs out, on the app's clock
     * (a token answer's `refresh_token_expires_in`); absent, Google named no end.
     */
    endsAt: z.number().optional(),
  })
  .strict();
export type GoogleSignInRecord = z.infer<typeof recordSchema>;

const clientSchema = z
  .object({
    /** The client id Google gave the person's own Desktop app client. */
    id: z.string().min(1).max(256),
    /** The Secrets reference of the client's secret, a hidden entry labelled Google client. */
    secret: z.string().min(1).max(64),
    /**
     * Google refused the client itself on a token request: `invalid_client`
     * (unknown or wrong secret) or `deleted_client`, and when.
     */
    refused: z
      .object({ error: z.enum(["invalid_client", "deleted_client"]), at: z.number() })
      .strict()
      .optional(),
  })
  .strict();
export type GoogleClientRecord = z.infer<typeof clientSchema>;

export class GoogleSignInStore {
  constructor(readonly root: string) {}

  /** The sign-in, or nothing; an unreadable file reads as none, with a warning. */
  read(): GoogleSignInRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, GOOGLE_FILE), "utf8");
    } catch {
      return undefined;
    }
    try {
      return recordSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("[integrations] the Google sign-in file could not be read; showing none");
      return undefined;
    }
  }

  /** Whether a sign-in file is here, readable or not, without reading what it holds. */
  present(): boolean {
    return filePresent(join(this.root, GOOGLE_FILE));
  }

  /** Write the one file whole, never readable by anyone else even mid-write. */
  write(record: GoogleSignInRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, GOOGLE_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  remove(): void {
    rmSync(join(this.root, GOOGLE_FILE), { force: true });
  }
}

/** The person's own Google client: its id and its secret's reference, never the secret. */
export class GoogleClientStore {
  constructor(readonly root: string) {}

  /** The client, or none; an unreadable file reads as none, with a warning. */
  read(): GoogleClientRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(join(this.root, CLIENT_FILE), "utf8");
    } catch {
      return undefined;
    }
    try {
      return clientSchema.parse(JSON.parse(raw));
    } catch {
      console.warn("[integrations] the Google client file could not be read; using none");
      return undefined;
    }
  }

  write(record: GoogleClientRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, CLIENT_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  remove(): void {
    rmSync(join(this.root, CLIENT_FILE), { force: true });
  }
}

/** Whether a file is there: true where it cannot be told, so an unreadable record is never read as none. */
function filePresent(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}
