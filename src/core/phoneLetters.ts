import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  LETTER_BOX_INFO,
  LETTER_SEAL_INFO,
  type PhonePushLetter,
  phoneLetterReadAnswerSchema,
  phoneLetterReadRelay,
  phonePushLetterSchema,
} from "@shared/phonePush";
import type { DevicePairing } from "./devices/pairing";
import type { LetterTaken } from "./devices/pairingPushRecords";

/**
 * Letters (docs/phone-push.md, "Letters"; INF-5275's plan, piece 2): a phone
 * keeps several computers but shows one at a time, so a computer it is not
 * showing cannot hear a renewed grant or a new push address from it. The
 * phone leaves each computer a sealed letter at the relay instead, in a box
 * only that computer and the phone can name, and each computer reads its box
 * once a day and right after the relay refuses its grant. Box and seal both
 * derive from the sealing key the phone handed that computer, so the relay
 * neither opens a letter nor tells whose box it is.
 */

/** How often a computer reads each phone's box. */
export const LETTER_READ_EVERY_MS = 86_400_000;

/** How long one read of a box may take. */
const READ_TIMEOUT_MS = 10_000;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function derive(key: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(key, "base64url"), Buffer.alloc(0), info, 32));
}

/** The box a phone's letters for this computer wait in: 32 bytes from its key, in base64url. */
export function letterBox(key: string): string {
  return derive(key, LETTER_BOX_INFO).toString("base64url");
}

/**
 * Seals one letter as a card push is sealed (AES-256-GCM, a random nonce,
 * base64url of nonce, ciphertext and tag), under the key derived for letters.
 */
export function sealLetter(key: string, letter: PhonePushLetter): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(key, LETTER_SEAL_INFO), nonce);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(letter), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64url");
}

/** Opens one letter sealed under `key`'s letter key; null when it was not, or says nothing known. */
export function openLetter(key: string, sealed: string): PhonePushLetter | null {
  try {
    const bytes = Buffer.from(sealed, "base64url");
    if (bytes.length <= NONCE_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(key, LETTER_SEAL_INFO),
      bytes.subarray(0, NONCE_BYTES),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]);
    const parsed = phonePushLetterSchema.safeParse(JSON.parse(plain.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type PhoneLettersOptions = {
  phones: Pick<DevicePairing, "letterBoxes" | "noteLetterRead" | "takeLetter">;
  /** Where card pushes go: Infinitary's relay, or a development run's stand-in. */
  relay: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** One line for a read that did not work; it never carries a box or a letter. */
  onProblem: (text: string) => void;
};

/** Reads each phone's box of letters, daily and right after a refusal. */
export class PhoneLetters {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** A read under way for each phone: a second ask joins it. */
  private readonly reading = new Map<string, Promise<LetterTaken | "none">>();

  constructor(private readonly options: PhoneLettersOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Reads every box not read in the last day; a read with no answer is tried at the next pass. */
  async readDue(): Promise<void> {
    const now = this.now();
    const due = this.options.phones
      .letterBoxes()
      .filter((box) => box.read === undefined || now - box.read >= LETTER_READ_EVERY_MS);
    await Promise.all(due.map((box) => this.read(box.deviceId, box.key)));
  }

  /**
   * The relay refused this phone's grant: its box is read once more now,
   * whenever it was last read. True when a newer letter renewed the
   * registration, so the refused card goes once more.
   */
  async readNow(deviceId: string): Promise<boolean> {
    const box = this.options.phones.letterBoxes().find((entry) => entry.deviceId === deviceId);
    if (!box) return false;
    return (await this.read(box.deviceId, box.key)) === "renewed";
  }

  private read(deviceId: string, key: string): Promise<LetterTaken | "none"> {
    const under = this.reading.get(deviceId);
    if (under) return under;
    const read = this.readBox(deviceId, key).finally(() => this.reading.delete(deviceId));
    this.reading.set(deviceId, read);
    return read;
  }

  private async readBox(deviceId: string, key: string): Promise<LetterTaken | "none"> {
    const { phones, relay, onProblem } = this.options;
    let response: Response;
    try {
      response = await this.fetchImpl(phoneLetterReadRelay(relay), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ box: letterBox(key) }),
        redirect: "error",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (error) {
      // i18n-exempt: a log line, never shown to a person
      onProblem(`a letter read did not reach the relay: ${(error as Error).name}`);
      return "none";
    }
    // 204: the box is empty. 404: a relay without letters, which means the same.
    if (response.status === 204 || response.status === 404) {
      phones.noteLetterRead(deviceId, this.now());
      return "none";
    }
    if (response.status !== 200) {
      // i18n-exempt: a log line, never shown to a person
      onProblem(`the push relay refused a letter read with ${response.status}`);
      return "none";
    }
    phones.noteLetterRead(deviceId, this.now());
    let sealed: string;
    try {
      sealed = phoneLetterReadAnswerSchema.parse(await response.json()).sealed;
    } catch {
      // i18n-exempt: a log line, never shown to a person
      onProblem("the push relay answered a letter read with something that is not a letter");
      return "none";
    }
    const letter = openLetter(key, sealed);
    if (!letter) {
      // i18n-exempt: a log line, never shown to a person
      onProblem("a letter in a phone's box did not open with its key");
      return "none";
    }
    return phones.takeLetter(deviceId, key, letter);
  }
}
