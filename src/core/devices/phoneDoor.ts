import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { DeviceInvite } from "../../shared/devices";
import {
  LINK_COMMAND_PATH,
  type LinkCommandAnswer,
  linkCommandForSchema,
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
 * line or error carries the link. A link is answered only once the
 * connection listens for it: the phone tries it the moment it has it, once
 * on each address, and calls the computer out of reach when refused.
 *
 * The same door, with the same key, answers this account's own `infinitary
 * link` (docs/run.md, "A link by command") at `LINK_COMMAND_PATH`: a link for
 * another computer or for a phone, and when it expires, as JSON.
 */

const LOOPBACK = "127.0.0.1";

export type PhoneDoorOptions = {
  /** The door's own folder (`AppPaths.phoneDoorDir`); emptied at open and close. */
  dir: string;
  /**
   * Makes a one-use link as Settings -> Devices does: a phone's, as its A
   * phone does, or with `phone` false a computer's, as its link for a Mac.
   */
  invite: (phone: boolean) => Pick<DeviceInvite, "link" | "expiresAt">;
  /**
   * Resolves once the connection listens for what pairing holds now, so the
   * device a link is for finds it listening when it dials, as a computer
   * added by its address does (`RemoteLoginOptions.listening`).
   */
  listening: () => Promise<void>;
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

  static async open(options: PhoneDoorOptions): Promise<PhoneDoor> {
    const { dir } = options;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    let door: PhoneDoor | undefined;
    const server = createServer((request, response) => void door?.handle(request, response));
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refuse = (status: number): void => {
      response.writeHead(status).end();
    };
    // Only this computer's loopback by its number, and no page's request.
    if (request.headers.host !== this.address || request.headers.origin !== undefined) {
      refuse(403);
      return;
    }
    const [path, query] = (request.url ?? "").split("?");
    if (path !== PHONE_DOOR_PATH && path !== LINK_COMMAND_PATH) {
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
    if (path === LINK_COMMAND_PATH) {
      await this.answerCommand(new URLSearchParams(query).get("for"), response);
      return;
    }
    let words: string;
    try {
      const { link } = this.options.invite(true);
      await this.listened();
      words = `link ${link}`;
    } catch {
      words = `none ${PHONE_LINK_NONE.refused}`;
    }
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
      .end(`${PHONE_LINK_HEADER} ${PHONE_LINK_VERSION} ${words}\n`);
  }

  /**
   * Waits until the connection listens for the link pairing just made. A wait
   * that fails still answers the link: the connection says itself why it
   * does not listen.
   */
  private async listened(): Promise<void> {
    try {
      await this.options.listening();
    } catch {
      // The device's own dial then finds the home out of reach.
    }
  }

  /** `infinitary link`'s answer: the link and when it expires, or why pairing made none. */
  private async answerCommand(asked: string | null, response: ServerResponse): Promise<void> {
    const kind = linkCommandForSchema.safeParse(asked);
    if (!kind.success) {
      response.writeHead(400).end();
      return;
    }
    let status = 200;
    let answer: LinkCommandAnswer;
    try {
      const { link, expiresAt } = this.options.invite(kind.data === "phone");
      await this.listened();
      answer = { link, expiresAt };
    } catch (error) {
      // Pairing refuses before it makes a code, so its words carry no link.
      status = 503;
      answer = { refused: error instanceof Error ? error.message : String(error) };
    }
    response
      .writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      })
      .end(`${JSON.stringify(answer)}\n`);
  }
}
