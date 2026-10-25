import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  PHONE_DOOR_FILES,
  PHONE_DOOR_KEY_HEADER,
  PHONE_DOOR_PATH,
  PHONE_LINK_HEADER,
  PHONE_LINK_NONE,
  PHONE_LINK_VERSION,
} from "../../shared/phoneLink";

/**
 * The phone's door (docs/devices.md, "A phone that joins by its address"):
 * how a phone signed in to this computer over SSH asks the open Infinitary
 * for a one-use phone link, by the fixed command in `src/shared/phoneLink.ts`.
 *
 * It is the task channel's pattern (docs/axi-commands.md, "The channel"):
 * the app listens on a port of this computer's loopback for the run and
 * writes that address and a 256-bit key, as the one header line curl sends,
 * to two files only their owner can read (0600) in a folder of the app's
 * data only its owner can open (0700). Reading the key is the permission:
 * only this account, signed in at the keyboard or over SSH, can, and it
 * could already make a link at the keyboard. A request a web page could
 * make - one naming another host or carrying an origin - is refused before
 * its key is read. The folder is emptied when the door opens and closes,
 * so a run that was killed leaves no key behind that answers.
 *
 * The answer is one line: the header, the door's version, then `link` and
 * the link, or `none refused` when pairing makes none. No log line, feed
 * line or error carries the link.
 */

const LOOPBACK = "127.0.0.1";

export type PhoneDoorOptions = {
  /** The door's own folder (`AppPaths.phoneDoorDir`); emptied at open and close. */
  dir: string;
  /** Makes a one-use phone link, as Settings -> Devices' A phone does. */
  invite: () => string;
};

function digestOf(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export class PhoneDoor {
  private closed = false;

  private constructor(
    private readonly options: PhoneDoorOptions,
    private readonly digest: Buffer,
    /** Where the fixed command reaches the door: this computer's loopback and the run's port. */
    readonly address: string,
    private readonly server: Server,
  ) {}

  /** Empty the door's folder, listen on a loopback port and write its two files. */
  static async open(options: PhoneDoorOptions): Promise<PhoneDoor> {
    const { dir } = options;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    let door: PhoneDoor | undefined;
    const server = createServer((request, response) => door?.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const { port } = server.address() as AddressInfo;
      const key = randomBytes(32).toString("hex");
      door = new PhoneDoor(options, digestOf(key), `${LOOPBACK}:${port}`, server);
      writeFileSync(join(dir, PHONE_DOOR_FILES.key), `${PHONE_DOOR_KEY_HEADER}: ${key}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      writeFileSync(join(dir, PHONE_DOOR_FILES.address), `${door.address}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return door;
    } catch (error) {
      server.close();
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Stop listening and remove the key, so nothing answers the command any more. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
    this.server.closeAllConnections();
    rmSync(this.options.dir, { recursive: true, force: true });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const refuse = (status: number): void => {
      response.writeHead(status).end();
    };
    // Only this computer's loopback by its number, and no page's request.
    if (request.headers.host !== this.address || request.headers.origin !== undefined) {
      refuse(403);
      return;
    }
    if ((request.url ?? "").split("?")[0] !== PHONE_DOOR_PATH) {
      refuse(404);
      return;
    }
    if (request.method !== "POST") {
      refuse(405);
      return;
    }
    const supplied = request.headers[PHONE_DOOR_KEY_HEADER];
    if (
      this.closed ||
      typeof supplied !== "string" ||
      !timingSafeEqual(digestOf(supplied.trim()), this.digest)
    ) {
      refuse(401);
      return;
    }
    request.resume();
    let words: string;
    try {
      words = `link ${this.options.invite()}`;
    } catch {
      words = `none ${PHONE_LINK_NONE.refused}`;
    }
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      .end(`${PHONE_LINK_HEADER} ${PHONE_LINK_VERSION} ${words}\n`);
  }
}
