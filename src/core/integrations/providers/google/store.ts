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
 * the access key it renews lives only in the app's memory. The Google
 * binding is its one writer.
 */

const GOOGLE_FILE = "google.json";

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
  })
  .strict();
export type GoogleSignInRecord = z.infer<typeof recordSchema>;

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

/** Whether a file is there: true where it cannot be told, so an unreadable record is never read as none. */
function filePresent(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}
