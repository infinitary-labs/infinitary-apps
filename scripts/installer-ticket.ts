import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Ticket = { exists: boolean | null; sha256?: string; error?: string };
type Run = (command: string, args: string[]) => string;

function installedTicket(app: string): Ticket {
  try {
    const bytes = readFileSync(join(app, "Contents/CodeResources"));
    return { exists: true, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    return { exists: null, error: String(error) };
  }
}

// Read only the ticket member, streaming its hash rather than unpacking an app.
// The disposable Mac already supplies Python for the signed-fixture ZIP reader.
const readArchiveTicket = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = [entry for entry in archive.infolist()
               if entry.filename == "Infinitary.app/Contents/CodeResources"]
    if not entries:
        print(json.dumps({"exists": False}))
    else:
        if len(entries) != 1 or entries[0].is_dir():
            raise ValueError("The fixture must contain one regular ticket member")
        digest = hashlib.sha256()
        with archive.open(entries[0]) as ticket:
            for chunk in iter(lambda: ticket.read(65536), b""):
                digest.update(chunk)
        print(json.dumps({"exists": True, "sha256": digest.hexdigest()}))
`;

/**
 * Require the installed copy to carry the exact stapled ticket the build job
 * already validated with Apple. A live stapler lookup from a hosted runner can
 * lose its network (run 40444437680), so installed checks compare bytes offline;
 * signature and Gatekeeper checks stay with the caller.
 */
export function verifyInstallerTicket(
  app: string,
  archive: string,
  run: Run,
  record: (check: string, result: string) => void,
): void {
  const installed = installedTicket(app);
  let fixture: Ticket;
  try {
    fixture = JSON.parse(run("/usr/bin/python3", ["-c", readArchiveTicket, archive]));
  } catch (error) {
    fixture = { exists: null, error: String(error) };
  }
  const matches = installed.exists === true && fixture.exists === true && installed.sha256 === fixture.sha256;
  if (!matches) {
    record("Stapled ticket mismatch", JSON.stringify({ installed, fixture, matches }));
    throw new Error(`The installed stapled ticket must match the build-validated ticket in ${archive}`);
  }
}
